// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PupateHook} from "../../src/PupateHook.sol";
import {PupateToken} from "../../src/PupateToken.sol";
import {PoolRouter} from "../utils/PoolRouter.sol";

/// @dev The part of IMD's launch factory this test calls, as its source verified on Sourcify declares
/// it. The factory deploys the token and the hook, initialises the pool and adds its one position in a
/// single call that only its deployer may make.
interface ILaunchFactory {
    struct Launch {
        bytes32 kind;
        uint64 launchNumber;
        uint64 recordedAt;
        bytes32 sourceCommit;
        bytes32 manifestHash;
        bytes32 attestationHash;
        bytes32 verifierKey;
        string sourceRepoUrl;
    }

    struct LaunchParams {
        uint64 launchNumber;
        bytes32 kind;
        bytes tokenCreationCode;
        bytes hookCreationCode;
        bytes32 hookSalt;
        uint160 hookFlags;
        uint256 totalSupply;
        uint16 poolBps;
        address remainderTo;
        bytes32 merkleRoot;
        uint64 contributorLockSeconds;
        uint64 sweepDelaySeconds;
        Currency pairedCurrency;
        uint24 fee;
        int24 tickSpacing;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        Launch record;
        uint256[] agentIds;
        address requester;
    }

    function launch(LaunchParams calldata params)
        external
        returns (address token, address hook, address distributor);
    function claimFees(uint64 launchNumber) external returns (uint256 amount0, uint256 amount1);
    function deployer() external view returns (address);
    function poolManager() external view returns (address);
    function predictHook(bytes calldata hookCreationCode, bytes32 hookSalt) external view returns (address);
}

/// @dev Runs only with MAINNET_RPC_URL set. The launch itself, rehearsed: IMD's real launch factory on a
/// fork of mainnet deploys this repository's token and hook with the launch's own constructor arguments
/// and pool parameters, called as the factory's deployer the way the launch wallet calls it. It shows
/// that the factory's one transaction passes the hook's liquidity gate, and that the gate is shut for
/// every transaction after it.
contract LaunchFactoryForkTest is Test {
    ILaunchFactory constant FACTORY = ILaunchFactory(0x12C63b581d07093F6126bc02263c58f7EadaA96F);
    IPoolManager constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90);
    /// @dev The hook's constructor arguments on mainnet (docs/deployment.md).
    address constant COCOON = 0x0adD7b9584cd73CeF21B39014e3ff6077BE53441;
    address constant TIMELOCK = 0x8bE826082c0FbAeC485048aA26ef42aC147898EC;
    uint160 constant HOOK_FLAGS = 0x18CC;
    /// @dev The opening the launch policy sets for an ETH pair: 1 ETH = 100,000,000 tokens, fee 12500,
    /// tick spacing 60, one token-only position from the lowest usable tick up to the opening price.
    uint160 constant SQRT_PRICE_OPEN = 792281625142643375935439503360000;
    uint24 constant LP_FEE = 12500;
    int24 constant TICK_SPACING = 60;
    int24 constant TICK_LOWER = -887_220;
    int24 constant TICK_UPPER = 184_200;
    uint256 constant POOL_TOKENS = 850_000_000 ether;
    /// @dev A number no real launch will carry.
    uint64 constant LAUNCH_NUMBER = 9_000_000_001;

    bool ready;
    address requester = makeAddr("requester");
    address token;
    address hook;
    address distributor;
    PoolKey key;
    PoolRouter router;

    receive() external payable {}

    function setUp() public {
        string memory url = vm.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        ready = true;
        vm.deal(address(this), 100 ether);
        router = new PoolRouter(POOL_MANAGER);
        assertEq(FACTORY.poolManager(), address(POOL_MANAGER), "the factory's pool manager");

        bytes memory hookCode =
            abi.encodePacked(type(PupateHook).creationCode, abi.encode(POOL_MANAGER, COCOON, TIMELOCK));
        (bytes32 salt, address predicted) = _mine(hookCode);
        assertEq(FACTORY.predictHook(hookCode, salt), predicted, "the factory predicts the same address");

        ILaunchFactory.LaunchParams memory p;
        p.launchNumber = LAUNCH_NUMBER;
        p.kind = bytes32("univ4_hook");
        p.tokenCreationCode = type(PupateToken).creationCode;
        p.hookCreationCode = hookCode;
        p.hookSalt = salt;
        p.hookFlags = HOOK_FLAGS;
        p.totalSupply = 1_000_000_000 ether;
        p.poolBps = 8500;
        p.remainderTo = requester;
        p.merkleRoot = keccak256("rehearsal");
        p.sweepDelaySeconds = 30 days;
        p.pairedCurrency = CurrencyLibrary.ADDRESS_ZERO;
        p.fee = LP_FEE;
        p.tickSpacing = TICK_SPACING;
        p.sqrtPriceX96 = SQRT_PRICE_OPEN;
        p.tickLower = TICK_LOWER;
        p.tickUpper = TICK_UPPER;
        uint256 width = TickMath.getSqrtPriceAtTick(TICK_UPPER) - TickMath.getSqrtPriceAtTick(TICK_LOWER);
        p.liquidity = uint128(FullMath.mulDiv(POOL_TOKENS, FixedPoint96.Q96, width));
        p.record.kind = p.kind;
        p.record.sourceRepoUrl = "rehearsal";
        p.requester = requester;

        // The whole launch is this one call, so in every test mode it is one transaction.
        address launcher = FACTORY.deployer();
        vm.prank(launcher);
        (token, hook, distributor) = FACTORY.launch(p);
        assertEq(hook, predicted, "the hook is at the mined address");
        key = PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(token), LP_FEE, TICK_SPACING, IHooks(hook));
    }

    function test_theRealFactoryOpensAndSeedsTheLaunchPoolInOneTransaction() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        PupateHook launched = PupateHook(payable(hook));
        assertEq(PoolId.unwrap(launched.launchPool()), PoolId.unwrap(key.toId()), "the launch pool");
        assertEq(launched.sink(), COCOON);
        assertEq(launched.owner(), TIMELOCK);
        assertEq(launched.openedAt(), block.timestamp);
        assertEq(launched.openedAtBlock(), block.number);
        assertEq(launched.buyTaxBps(), 9900);

        (uint160 sqrtPrice, int24 tick,,) = StateLibrary.getSlot0(POOL_MANAGER, key.toId());
        assertEq(sqrtPrice, SQRT_PRICE_OPEN);
        assertEq(tick, 184_216);

        PupateToken launchedToken = PupateToken(token);
        assertEq(launchedToken.totalSupply(), 1_000_000_000 ether);
        assertEq(launchedToken.balanceOf(distributor), 100_000_000 ether, "the swarm's tenth");
        assertApproxEqAbs(launchedToken.balanceOf(requester), 50_000_000 ether, 1e6, "the requester's 5%");
        assertApproxEqAbs(
            launchedToken.balanceOf(address(POOL_MANAGER)), POOL_TOKENS, 1e6, "the pool holds the seed"
        );
        assertEq(launchedToken.balanceOf(address(FACTORY)), 0, "the factory keeps nothing");
    }

    function test_afterTheFactorysTransactionTheLaunchPoolIsClosedToLiquidity() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        // The same block as the launch, a later transaction. An ETH-only range above the price is the
        // position that would take tokens from sellers without paying the buy tax.
        vm.expectRevert(_closed());
        router.addLiquidity{value: 1 ether}(key, ModifyLiquidityParams(184_260, 184_320, 1e24, bytes32(0)));

        // Nor can the requester put tokens back beside the factory's position.
        vm.prank(requester);
        PupateToken(token).approve(address(router), type(uint256).max);
        vm.expectRevert(_closed());
        vm.prank(requester);
        router.addLiquidity(key, ModifyLiquidityParams(TICK_LOWER, TICK_UPPER, 1e15, bytes32(0)));
    }

    function test_swapsAreTaxedAndTheFactoryStillCollectsItsPoolFees() public {
        if (!ready) {
            vm.skip(true);
            return;
        }
        router.swap{value: 1 ether}(key, SwapParams(true, -1 ether, TickMath.MIN_SQRT_PRICE + 1));
        assertEq(POOL_MANAGER.balanceOf(hook, 0), 0.99 ether, "99% of a buy at the open is tax");
        assertGt(PupateToken(token).balanceOf(address(this)), 0);

        // The factory collects the pool's LP fees with a zero-liquidity call on its position. The
        // PoolManager routes that to the remove-liquidity callbacks, which the hook does not gate.
        (uint256 fee0, uint256 fee1) = FACTORY.claimFees(LAUNCH_NUMBER);
        assertGt(fee0, 0, "ETH fees reach the factory");
        assertEq(fee1, 0);
    }

    /// @dev The first salt whose CREATE2 address, deployed by the factory, carries exactly the hook's
    /// flags and is still empty on this fork.
    function _mine(bytes memory creationCode) internal view returns (bytes32, address) {
        bytes32 codeHash = keccak256(creationCode);
        for (uint256 salt; salt < 2_000_000; ++salt) {
            address predicted = address(
                uint160(
                    uint256(
                        keccak256(abi.encodePacked(bytes1(0xff), address(FACTORY), bytes32(salt), codeHash))
                    )
                )
            );
            if (uint160(predicted) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS && predicted.code.length == 0) {
                return (bytes32(salt), predicted);
            }
        }
        revert("no salt");
    }

    /// @dev The PoolManager wraps a hook revert: WrappedError(hook, callback, reason, HookCallFailed).
    function _closed() internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            hook,
            IHooks.beforeAddLiquidity.selector,
            abi.encodeWithSelector(PupateHook.LiquidityClosed.selector),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }
}
