// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Plain ERC-20 used in tests.
contract MockToken {
    string public constant name = "Mock LOCKRA";
    string public constant symbol = "mLOCKRA";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice Takes 1% of every transfer. The arena must refuse it.
contract FeeOnTransferToken is MockToken {
    function _move(address from, address to, uint256 amount) internal override {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
    }
}

/// @notice Tries to re-enter the arena while it pays out.
contract ReentrantToken is MockToken {
    address public target;
    bytes public payload;
    bool public reentered;
    bytes public reentryError;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (target != address(0) && msg.sender == target && !reentered) {
            reentered = true;
            (bool ok, bytes memory err) = target.call(payload);
            require(!ok, "reentry succeeded");
            reentryError = err;
        }
        return super.transfer(to, amount);
    }
}
