// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IIdentityRegistry} from "./Interfaces.sol";

/// @title PRYSM League - weekly season rewards for the top agents, claimed against a published Merkle root
/// @notice Rewards come from a fixed pool the owner funds per season (no minting, no share of anyone's trading profit).
/// A claim always pays the agent's current ERC-8004 owner, whoever submits it.
contract League is Ownable {
    using SafeERC20 for IERC20;

    struct Season { bytes32 root; uint256 total; uint256 claimed; uint64 openedAt; string uri; }

    IIdentityRegistry public immutable identity;
    IERC20 public immutable token;
    Season[] public seasons;
    mapping(uint256 => mapping(uint256 => bool)) public claimed;   // season => agentId => claimed

    event SeasonOpened(uint256 indexed season, bytes32 root, uint256 total, string uri);
    event Claimed(uint256 indexed season, uint256 indexed agentId, address to, uint256 amount);
    event Swept(uint256 indexed season, uint256 amount);

    error AlreadyClaimed();
    error BadProof();
    error TooSoon();
    error OverClaim();

    constructor(address identity_, address token_) Ownable(msg.sender) {
        identity = IIdentityRegistry(identity_);
        token = IERC20(token_);
    }

    /// @param uri where the full ranking behind the root is published (so anyone can rebuild and check it)
    function openSeason(bytes32 root, uint256 total, string calldata uri) external onlyOwner returns (uint256 season) {
        token.safeTransferFrom(msg.sender, address(this), total);
        season = seasons.length;
        seasons.push(Season(root, total, 0, uint64(block.timestamp), uri));
        emit SeasonOpened(season, root, total, uri);
    }

    function leaf(uint256 season, uint256 agentId, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(season, agentId, amount))));
    }

    function claim(uint256 season, uint256 agentId, uint256 amount, bytes32[] calldata proof) external {
        if (claimed[season][agentId]) revert AlreadyClaimed();
        Season storage s = seasons[season];
        if (!MerkleProof.verifyCalldata(proof, s.root, leaf(season, agentId, amount))) revert BadProof();
        // never more than the season holds: after a sweep (claimed == total) every late claim fails, and a bad root
        // whose leaves add up to more than `total` cannot drain other seasons' funds
        if (s.claimed + amount > s.total) revert OverClaim();
        claimed[season][agentId] = true;
        s.claimed += amount;
        address to = identity.ownerOf(agentId);
        token.safeTransfer(to, amount);
        emit Claimed(season, agentId, to, amount);
    }

    /// @notice unclaimed rewards return to the owner (to roll into a later season) after 90 days
    function sweep(uint256 season) external onlyOwner {
        Season storage s = seasons[season];
        if (block.timestamp < s.openedAt + 90 days) revert TooSoon();
        uint256 left = s.total - s.claimed;
        s.claimed = s.total;
        token.safeTransfer(msg.sender, left);
        emit Swept(season, left);
    }

    function seasonCount() external view returns (uint256) { return seasons.length; }
}
