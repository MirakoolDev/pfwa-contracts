// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

/// Uniswap V3 SwapRouter02 multi-hop (no deadline field).
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title FeeCollector
/// @notice Receives the protocol's USDG (swap fees, creation fees, the slashed-bond cut) and buys back $PFWA.
/// The owner or the keeper triggers a buyback, at most once per `buybackInterval`, with a minimum-out
/// quoted off-chain. Restricted so nobody can force a buyback with no price protection and sandwich it.
/// The bought $PFWA goes to the treasury, or is burned if `burnBoughtBack` is set.
contract FeeCollector is Ownable {
    using SafeERC20 for IERC20;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable usdg;
    IERC20 public immutable pfwa;
    ISwapRouter02 public router;
    /// V3 path from USDG to $PFWA, e.g. USDG ─fee─▶ WETH ─fee─▶ PFWA.
    bytes public path;
    address public treasury;
    bool public burnBoughtBack;
    uint256 public buybackInterval = 1 hours;
    uint256 public lastBuyback;
    /// Wallet allowed to trigger buybacks besides the owner (the PFWA keeper).
    address public keeper;

    event Buyback(address indexed caller, uint256 usdgIn, uint256 pfwaOut, address to);
    event KeeperUpdated(address keeper);
    event ConfigUpdated(address router, bytes path, address treasury, bool burnBoughtBack, uint256 buybackInterval);

    error TooSoon();
    error NotKeeper();
    error NothingToSwap();
    error BadPath();

    constructor(address owner_, IERC20 usdg_, IERC20 pfwa_, ISwapRouter02 router_, bytes memory path_, address treasury_)
        Ownable(owner_)
    {
        usdg = usdg_;
        pfwa = pfwa_;
        _configure(router_, path_, treasury_, false, 1 hours);
    }

    /// @notice Swap every USDG held into $PFWA. `minOut` protects against a bad price.
    function buyback(uint256 minOut) external returns (uint256 pfwaOut) {
        if (msg.sender != owner() && msg.sender != keeper) revert NotKeeper();
        if (lastBuyback != 0 && block.timestamp < lastBuyback + buybackInterval) revert TooSoon();
        uint256 amountIn = usdg.balanceOf(address(this));
        if (amountIn == 0) revert NothingToSwap();
        lastBuyback = block.timestamp;

        address to = burnBoughtBack ? DEAD : treasury;
        usdg.forceApprove(address(router), amountIn);
        pfwaOut = router.exactInput(
            ISwapRouter02.ExactInputParams({path: path, recipient: to, amountIn: amountIn, amountOutMinimum: minOut})
        );
        emit Buyback(msg.sender, amountIn, pfwaOut, to);
    }

    function setKeeper(address keeper_) external onlyOwner {
        keeper = keeper_;
        emit KeeperUpdated(keeper_);
    }

    function configure(ISwapRouter02 router_, bytes calldata path_, address treasury_, bool burn_, uint256 interval_)
        external
        onlyOwner
    {
        _configure(router_, path_, treasury_, burn_, interval_);
    }

    function _configure(ISwapRouter02 router_, bytes memory path_, address treasury_, bool burn_, uint256 interval_)
        internal
    {
        // A V3 path is token(20) + [fee(3) + token(20)]*, starting at USDG and ending at $PFWA.
        if (path_.length < 43 || (path_.length - 20) % 23 != 0) revert BadPath();
        if (_firstToken(path_) != address(usdg) || _lastToken(path_) != address(pfwa)) revert BadPath();
        router = router_;
        path = path_;
        treasury = treasury_;
        burnBoughtBack = burn_;
        buybackInterval = interval_;
        emit ConfigUpdated(address(router_), path_, treasury_, burn_, interval_);
    }

    function _firstToken(bytes memory p) internal pure returns (address a) {
        assembly {
            a := shr(96, mload(add(p, 32)))
        }
    }

    function _lastToken(bytes memory p) internal pure returns (address a) {
        uint256 offset = p.length - 20;
        assembly {
            a := shr(96, mload(add(add(p, 32), offset)))
        }
    }
}
