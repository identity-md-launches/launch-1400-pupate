// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IERC20Minimal} from "../../src/interfaces/IERC20Minimal.sol";

/// @notice LOCAL ONLY. Stands in for the last step of IMD's launch factory: initialise the launch pool
/// and seed it with the token share in ONE transaction. `PupateHook.beforeAddLiquidity` admits
/// liquidity only in the transaction that opened the pool, so the two steps cannot be separate transactions.
/// @dev The seed is the single-sided position of `test/utils/PoolSetup.sol::_seed`: every token this
/// contract holds, from the lowest usable tick up to the tick-spacing boundary at or below the opening
/// tick. It needs no ETH; buys walk the price down into it. The position stays owned by this contract,
/// as IMD's factory keeps the real one. Whatever the rounding leaves over goes back to the caller.
contract LocalLaunchFactory is IUnlockCallback {
    error OnlyPoolManager();
    error NothingToSeed();
    error UnexpectedDelta();
    error TransferFailed();

    event Opened(
        PoolId indexed poolId, int24 tick, int24 lower, int24 upper, uint256 liquidity, uint256 seeded
    );

    IPoolManager public immutable poolManager;

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice Initialise `key` at `sqrtPriceX96`, then add this contract's whole balance of
    /// `key.currency1` as one-sided liquidity below the opening price. One transaction.
    /// @return tick the opening tick, `lower`/`upper` the seeded range, `liquidity` its size, and
    /// `seeded` the tokens the PoolManager actually took.
    function open(PoolKey calldata key, uint160 sqrtPriceX96)
        external
        returns (int24 tick, int24 lower, int24 upper, uint256 liquidity, uint256 seeded)
    {
        IERC20Minimal token = IERC20Minimal(Currency.unwrap(key.currency1));
        uint256 tokens = token.balanceOf(address(this));
        if (tokens == 0) revert NothingToSeed();

        tick = poolManager.initialize(key, sqrtPriceX96);

        upper = (tick / key.tickSpacing) * key.tickSpacing;
        if (tick < 0 && tick % key.tickSpacing != 0) upper -= key.tickSpacing;
        lower = TickMath.minUsableTick(key.tickSpacing);
        uint256 width = TickMath.getSqrtPriceAtTick(upper) - TickMath.getSqrtPriceAtTick(lower);
        liquidity = FullMath.mulDiv(tokens, FixedPoint96.Q96, width);

        seeded = abi.decode(poolManager.unlock(abi.encode(key, lower, upper, liquidity)), (uint256));

        uint256 rest = token.balanceOf(address(this));
        if (rest != 0 && !token.transfer(msg.sender, rest)) revert TransferFailed();
        emit Opened(key.toId(), tick, lower, upper, liquidity, seeded);
    }

    /// @inheritdoc IUnlockCallback
    /// @dev Reached only from `open`. Adds the position and pays the PoolManager the tokens it asks for.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (PoolKey memory key, int24 lower, int24 upper, uint256 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, uint256));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(lower, upper, int256(liquidity), bytes32(0)), ""
        );
        // Entirely below the opening price: no ETH owed, tokens owed.
        if (delta.amount0() != 0 || delta.amount1() >= 0) revert UnexpectedDelta();
        uint256 owed = uint256(uint128(-delta.amount1()));

        poolManager.sync(key.currency1);
        if (!IERC20Minimal(Currency.unwrap(key.currency1)).transfer(address(poolManager), owed)) {
            revert TransferFailed();
        }
        poolManager.settle();
        return abi.encode(owed);
    }
}
