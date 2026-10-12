// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

interface IERC20Like {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Test-only router. Runs one swap or one liquidity change per call and settles the caller's
/// deltas: ETH from the value sent along, tokens by transferFrom. Unspent ETH goes back to the caller.
/// No slippage or deadline checks.
contract PoolRouter is IUnlockCallback {
    struct Job {
        address payer;
        PoolKey key;
        bool isSwap;
        SwapParams swap;
        ModifyLiquidityParams liquidity;
    }

    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    receive() external payable {}

    function swap(PoolKey memory key, SwapParams memory params) external payable returns (BalanceDelta) {
        ModifyLiquidityParams memory none;
        return _run(Job(msg.sender, key, true, params, none));
    }

    function addLiquidity(PoolKey memory key, ModifyLiquidityParams memory params)
        external
        payable
        returns (BalanceDelta)
    {
        SwapParams memory none;
        return _run(Job(msg.sender, key, false, none, params));
    }

    /// @dev Initialises `key` and adds its first liquidity in one call, the way a launch factory opens
    /// and seeds a pool in one transaction.
    function open(PoolKey memory key, uint160 sqrtPriceX96, ModifyLiquidityParams memory params)
        external
        payable
        returns (BalanceDelta)
    {
        manager.initialize(key, sqrtPriceX96);
        SwapParams memory none;
        return _run(Job(msg.sender, key, false, none, params));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        Job memory job = abi.decode(data, (Job));
        BalanceDelta delta;
        if (job.isSwap) {
            delta = manager.swap(job.key, job.swap, "");
        } else {
            (delta,) = manager.modifyLiquidity(job.key, job.liquidity, "");
        }
        _resolve(job.key.currency0, job.payer, delta.amount0());
        _resolve(job.key.currency1, job.payer, delta.amount1());
        return abi.encode(delta);
    }

    /// @dev ETH this contract already held stays put; only what the call left over is returned.
    function _run(Job memory job) private returns (BalanceDelta delta) {
        uint256 held = address(this).balance - msg.value;
        delta = abi.decode(manager.unlock(abi.encode(job)), (BalanceDelta));
        uint256 unspent = address(this).balance - held;
        if (unspent != 0) {
            (bool ok,) = msg.sender.call{value: unspent}("");
            require(ok, "refund failed");
        }
    }

    /// @dev A positive delta is owed to the payer; a negative one is owed by the payer.
    function _resolve(Currency currency, address payer, int128 amount) private {
        if (amount > 0) {
            manager.take(currency, payer, uint128(amount));
        } else if (amount < 0) {
            uint256 owed = uint128(-amount);
            if (currency.isAddressZero()) {
                manager.settle{value: owed}();
            } else {
                manager.sync(currency);
                require(
                    IERC20Like(Currency.unwrap(currency)).transferFrom(payer, address(manager), owed),
                    "pay failed"
                );
                manager.settle();
            }
        }
    }
}
