// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "v4-core/src/types/BeforeSwapDelta.sol";
import {CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {ITaxSink} from "./interfaces/ITaxSink.sol";

/// @notice Uniswap v4 hook that taxes the ETH side of every trade in the Pupate launch pool.
/// @dev The tax is taken inside the swap as ERC-6909 claims on the PoolManager: no ETH moves and no
/// contract other than the PoolManager is called from a swap callback. `flush` turns the claims into
/// ETH and hands them to the sink. The hook's address must encode afterInitialize, beforeSwap,
/// beforeAddLiquidity, afterSwap, beforeSwapReturnDelta and afterSwapReturnDelta: low 14 bits 0x18CC.
/// Liquidity can be added only to the launch pool and only in the transaction that opens it, so after
/// the launch the pool's liquidity can only shrink and nobody can trade by resting liquidity untaxed.
contract PupateHook is IUnlockCallback {
    using SafeCast for uint256;

    error ZeroAddress();
    error OnlyPoolManager();
    error NotOwner();
    error NotLower();
    error PartialFill();
    error NothingToFlush();
    error LiquidityClosed();

    event LaunchPoolSet(PoolId indexed poolId, uint256 openedAt);
    event Taxed(address indexed sender, bool buy, uint256 tax, uint256 rateBps);
    event Flushed(uint256 amount);
    event TaxLowered(uint256 taxBps);
    event OwnershipTransferred(address indexed from, address indexed to);

    uint256 public constant BPS = 10_000;
    /// @notice Buy tax at the moment the launch pool opens.
    uint256 public constant LAUNCH_TAX_BPS = 9900;
    /// @notice How fast the launch buy tax falls towards the standing tax.
    uint256 public constant LAUNCH_DECAY_BPS_PER_MINUTE = 100;
    /// @dev ERC-6909 id of native ETH on the PoolManager.
    uint256 private constant ETH_CLAIM_ID = 0;
    /// @dev Transient storage slot (EIP-1153) holding 1 from the moment the launch pool is initialised
    /// to the end of that transaction, and 0 at every other time.
    uint256 private constant OPENING_SLOT = uint256(keccak256("pupate.hook.opening")) - 1;

    IPoolManager public immutable poolManager;
    /// @notice Receives every flushed wei. Swaps the sink makes itself are not taxed.
    address public immutable sink;

    /// @notice May lower the standing tax. Nothing can raise it.
    address public owner;
    /// @notice When the launch pool was initialised. Zero until then.
    uint40 public openedAt;
    /// @notice Standing tax on the ETH side of every buy and sell, in basis points.
    uint16 public taxBps = 600;
    /// @notice Block in which the launch pool was initialised. For the record only: liquidity is gated
    /// by the opening transaction, not by this block.
    uint40 public openedAtBlock;
    /// @notice The first native-ETH pool initialised on this hook. Only this pool is taxed.
    PoolId public launchPool;
    /// @notice Every wei of tax ever collected.
    uint256 public totalTax;

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_, address sink_, address owner_) {
        if (address(poolManager_) == address(0) || sink_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        poolManager = poolManager_;
        sink = sink_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    /// @dev ETH only ever arrives from the PoolManager, during `flush`.
    receive() external payable {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.afterInitialize = true;
        permissions.beforeAddLiquidity = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
    }

    /// @notice The buy tax right now: 99% when the launch pool opens, one point lower each minute,
    /// until it meets the standing tax.
    function buyTaxBps() public view returns (uint256) {
        uint256 standing = taxBps;
        uint256 opened = openedAt;
        if (opened == 0) return standing;
        uint256 fallen = (block.timestamp - opened) * LAUNCH_DECAY_BPS_PER_MINUTE / 60;
        if (fallen >= LAUNCH_TAX_BPS - standing) return standing;
        return LAUNCH_TAX_BPS - fallen;
    }

    // ------------------------------------------------------------------ pool callbacks

    /// @notice `IHooks.afterInitialize`. Records the first native-ETH pool as the launch pool.
    function afterInitialize(address, PoolKey calldata key, uint160, int24)
        external
        onlyPoolManager
        returns (bytes4)
    {
        if (openedAt == 0 && key.currency0.isAddressZero()) {
            PoolId id = key.toId();
            launchPool = id;
            openedAt = uint40(block.timestamp);
            openedAtBlock = uint40(block.number);
            // Marks the rest of this transaction as the opening one. Transient storage is wiped when the
            // transaction ends, so the mark cannot outlive it.
            uint256 slot = OPENING_SLOT;
            assembly ("memory-safe") {
                tstore(slot, 1)
            }
            emit LaunchPoolSet(id, block.timestamp);
        }
        return IHooks.afterInitialize.selector;
    }

    /// @notice `IHooks.beforeAddLiquidity`. Admits liquidity only into the launch pool, and only in
    /// the transaction that opened it: the factory opens and seeds the pool in one transaction, and a
    /// later transaction finds the pool closed, even in the same block. Removing liquidity is never
    /// gated.
    function beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        uint256 slot = OPENING_SLOT;
        uint256 opening;
        assembly ("memory-safe") {
            opening := tload(slot)
        }
        if (opening == 0 || PoolId.unwrap(key.toId()) != PoolId.unwrap(launchPool)) revert LiquidityClosed();
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @notice `IHooks.beforeSwap`. When the trader names the ETH amount, the tax is returned here as a
    /// positive specified delta. Nothing is stored; `afterSwap` checks the fill and collects.
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        view
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (!_taxed(sender, key) || !_namesEth(params)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 tax = _taxOnNamedEth(params, _rate(params.zeroForOne));
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(tax.toInt128(), 0), 0);
    }

    /// @notice `IHooks.afterSwap`. `delta` is the pool's raw delta, before the hook's own.
    /// @dev When the trader named the ETH amount, the pool must have moved exactly that amount net of
    /// the tax; otherwise the fill was partial and the swap reverts. When the trader named the token
    /// amount, the tax is computed from the ETH the pool actually moved and returned as a positive
    /// unspecified delta. Either way the tax is minted to the hook as claims.
    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        if (!_taxed(sender, key)) return (IHooks.afterSwap.selector, 0);

        bool buy = params.zeroForOne;
        uint256 rate = _rate(buy);
        uint256 tax;
        int128 unspecified;
        if (_namesEth(params)) {
            tax = _taxOnNamedEth(params, rate);
            if (int256(delta.amount0()) != params.amountSpecified + int256(tax)) revert PartialFill();
        } else {
            int128 eth = delta.amount0();
            // A buy pays ETH into the pool (negative delta) and the tax comes on top of it. A sell
            // takes ETH out of the pool (positive delta) and the tax comes out of it.
            tax = buy ? uint256(uint128(-eth)) * rate / (BPS - rate) : uint256(uint128(eth)) * rate / BPS;
            unspecified = tax.toInt128();
        }

        if (tax != 0) {
            totalTax += tax;
            emit Taxed(sender, buy, tax, rate);
            // Minting claims debits the hook; the positive hook delta the PoolManager books after this
            // callback cancels that debit.
            poolManager.mint(address(this), ETH_CLAIM_ID, tax);
        }
        return (IHooks.afterSwap.selector, unspecified);
    }

    // ------------------------------------------------------------------ flushing

    /// @notice Converts every collected claim to ETH and hands it to the sink. Anyone may call.
    function flush() external returns (uint256 amount) {
        uint256 claims = poolManager.balanceOf(address(this), ETH_CLAIM_ID);
        if (claims == 0) revert NothingToFlush();
        poolManager.unlock(abi.encode(claims));
        amount = address(this).balance;
        emit Flushed(amount);
        ITaxSink(sink).depositTax{value: amount}();
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Reached only through `flush`. Burning the hook's claims credits it; taking the same amount
    /// of ETH settles that credit.
    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        uint256 claims = abi.decode(data, (uint256));
        poolManager.burn(address(this), ETH_CLAIM_ID, claims);
        poolManager.take(CurrencyLibrary.ADDRESS_ZERO, address(this), claims);
        return "";
    }

    // ------------------------------------------------------------------ owner

    /// @notice Lower the standing tax. It can never be raised.
    function lowerTax(uint16 newTaxBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (newTaxBps >= taxBps) revert NotLower();
        taxBps = newTaxBps;
        emit TaxLowered(newTaxBps);
    }

    function transferOwnership(address to) external {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }

    // ------------------------------------------------------------------ internals

    /// @dev Only the launch pool is taxed, and never the sink's own swaps.
    function _taxed(address sender, PoolKey calldata key) private view returns (bool) {
        return sender != sink && PoolId.unwrap(key.toId()) == PoolId.unwrap(launchPool);
    }

    /// @dev ETH is currency0, so the trader names the ETH amount exactly when the swap is an
    /// exact-input buy or an exact-output sell.
    function _namesEth(SwapParams calldata params) private pure returns (bool) {
        return (params.amountSpecified < 0) == params.zeroForOne;
    }

    function _rate(bool buy) private view returns (uint256) {
        return buy ? buyTaxBps() : taxBps;
    }

    /// @dev Exact-input buy: the trader names the gross ETH they pay, and the tax is a share of it.
    /// Exact-output sell: the trader names the net ETH they receive, and the pool pays that plus the
    /// tax, so the tax is the same share of the gross.
    function _taxOnNamedEth(SwapParams calldata params, uint256 rate) private pure returns (uint256) {
        if (params.zeroForOne) return uint256(-params.amountSpecified) * rate / BPS;
        return uint256(params.amountSpecified) * rate / (BPS - rate);
    }
}
