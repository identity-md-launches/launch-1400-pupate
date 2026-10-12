// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {PupateToken} from "../../src/PupateToken.sol";
import {PoolRouter} from "./PoolRouter.sol";

/// @dev Shared offline setup: a fresh PoolManager, a settlement router, and the PUPATE supply held by
/// the test contract. Pools open the way the launch does: at a 10 ETH valuation, seeded with tokens only.
abstract contract PoolSetup is Test {
    /// @dev 1 ETH buys 100,000,000 PUPATE, so the whole supply is worth 10 ETH. sqrt(1e8) * 2^96.
    uint160 internal constant SQRT_PRICE_OPEN = 792281625142643375935439503360000;
    uint24 internal constant LP_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant POOL_SHARE = 850_000_000 ether;
    uint256 internal constant T0 = 1_800_000_000;

    IPoolManager internal manager;
    PoolRouter internal router;
    PupateToken internal token;

    /// @dev The last position `_openParams` described, so tests can remove from it.
    int24 internal seedLower;
    int24 internal seedUpper;
    uint256 internal seedLiquidity;

    receive() external payable {}

    function setUp() public virtual {
        vm.warp(T0);
        manager = IPoolManager(address(new PoolManager(address(this))));
        router = new PoolRouter(manager);
        token = new PupateToken();
        token.approve(address(router), type(uint256).max);
        vm.deal(address(this), 1_000_000 ether);
    }

    function _ethPool(address quote, address hooks) internal pure returns (PoolKey memory) {
        return
            PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(quote), LP_FEE, TICK_SPACING, IHooks(hooks));
    }

    /// @dev Opens a pool the way the launch factory does: initialised and seeded by one call, so in
    /// one transaction whatever mode the tests run in.
    function _open(PoolKey memory poolKey, uint256 tokens) internal {
        router.open(poolKey, SQRT_PRICE_OPEN, _openParams(poolKey, tokens));
    }

    /// @dev The opening position of a launch: `tokens` of currency1 as one-sided liquidity from the
    /// lowest usable tick up to the tick spacing boundary at or below the opening tick. It needs no ETH,
    /// and buys walk the price into it.
    function _openParams(PoolKey memory poolKey, uint256 tokens)
        internal
        returns (ModifyLiquidityParams memory)
    {
        int24 tick = TickMath.getTickAtSqrtPrice(SQRT_PRICE_OPEN);
        int24 upper = (tick / poolKey.tickSpacing) * poolKey.tickSpacing;
        if (tick < 0 && tick % poolKey.tickSpacing != 0) upper -= poolKey.tickSpacing;
        int24 lower = TickMath.minUsableTick(poolKey.tickSpacing);
        uint256 width = TickMath.getSqrtPriceAtTick(upper) - TickMath.getSqrtPriceAtTick(lower);
        uint256 liquidity = FullMath.mulDiv(tokens, FixedPoint96.Q96, width);
        seedLower = lower;
        seedUpper = upper;
        seedLiquidity = liquidity;
        return ModifyLiquidityParams(lower, upper, int256(liquidity), bytes32(0));
    }

    function _limit(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// @dev Swaps as the test contract. Buys send plenty of ETH along; the router returns the rest.
    function _swap(PoolRouter via, PoolKey memory poolKey, bool zeroForOne, int256 amountSpecified)
        internal
        returns (BalanceDelta)
    {
        uint256 value = zeroForOne ? 100_000 ether : 0;
        return via.swap{value: value}(poolKey, SwapParams(zeroForOne, amountSpecified, _limit(zeroForOne)));
    }

    function _sqrtPrice(PoolKey memory poolKey) internal view returns (uint160 sqrtPrice) {
        (sqrtPrice,,,) = StateLibrary.getSlot0(manager, poolKey.toId());
    }
}
