// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIdentityRegistry} from "./Interfaces.sol";

/// @title PRYSM Subscriptions - pay an agent's owner for early access to its sealed signals
/// @notice Buys data access only: funds go straight to the agent owner (minus the protocol fee), nothing is pooled or
/// traded on the subscriber's behalf. The relay checks `activeUntil` before handing out a signal before its reveal.
contract Subscriptions is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant PERIOD = 30 days;
    uint16 public constant MAX_FEE_BPS = 2000;

    IIdentityRegistry public immutable identity;
    IERC20 public immutable token;
    address public treasury;
    uint16 public feeBps;

    mapping(uint256 => uint256) public price;                           // agentId => token per 30 days (0 = not offered)
    mapping(uint256 => mapping(address => uint64)) public activeUntil;  // agentId => subscriber => unix time

    event PriceSet(uint256 indexed agentId, uint256 price);
    event Subscribed(uint256 indexed agentId, address indexed subscriber, uint256 periods, uint256 paid, uint64 until);

    error NotOwner();
    error NotOffered();
    error BadPeriods();
    error FeeTooHigh();
    error PriceChanged();

    constructor(address identity_, address token_, address treasury_, uint16 feeBps_) Ownable(msg.sender) {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        identity = IIdentityRegistry(identity_);
        token = IERC20(token_);
        treasury = treasury_;
        feeBps = feeBps_;
    }

    function setFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
    }
    function setTreasury(address t) external onlyOwner { treasury = t; }

    function setPrice(uint256 agentId, uint256 p) external {
        if (identity.ownerOf(agentId) != msg.sender) revert NotOwner();
        price[agentId] = p;
        emit PriceSet(agentId, p);
    }

    /// @param maxCost the most the subscriber agreed to pay, so a price raised just before this lands cannot overcharge
    function subscribe(uint256 agentId, uint256 periods, uint256 maxCost) external {
        uint256 p = price[agentId];
        if (p == 0) revert NotOffered();
        if (periods == 0 || periods > 12) revert BadPeriods();
        uint256 cost = p * periods;
        if (cost > maxCost) revert PriceChanged();
        uint256 fee = cost * feeBps / 10_000;
        if (fee > 0) token.safeTransferFrom(msg.sender, treasury, fee);
        token.safeTransferFrom(msg.sender, identity.ownerOf(agentId), cost - fee);
        uint64 start = activeUntil[agentId][msg.sender];
        if (start < block.timestamp) start = uint64(block.timestamp);
        uint64 until = start + uint64(PERIOD * periods);
        activeUntil[agentId][msg.sender] = until;
        emit Subscribed(agentId, msg.sender, periods, cost, until);
    }

    function isActive(uint256 agentId, address who) external view returns (bool) {
        return activeUntil[agentId][who] >= block.timestamp;
    }
}
