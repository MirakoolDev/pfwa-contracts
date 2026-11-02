// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title OutcomeToken
/// @notice One outcome of an order book market, e.g. "YES". An ERC-20 with 6 decimals, the same as USDG,
/// so one token is worth one USDG at par. Deployed as an EIP-1167 clone; only its market can mint or burn.
contract OutcomeToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public market;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error AlreadyInitialized();
    error NotMarket();

    /// The implementation can never be initialised: only its clones are.
    constructor() {
        market = address(1);
    }

    function initialize(string calldata name_, string calldata symbol_, address market_) external {
        if (market != address(0)) revert AlreadyInitialized();
        name = name_;
        symbol = symbol_;
        market = market_;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != market) revert NotMarket();
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != market) revert NotMarket();
        balanceOf[from] -= amount;
        unchecked {
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
