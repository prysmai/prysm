// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// ERC-8004 registries (erc-8004/erc-8004-contracts, deployed at the same address on every chain)
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
    function getAgentWallet(uint256 agentId) external view returns (address);
}

interface IReputationRegistry {
    function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2,
        string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external;
}

// the slice of a Uniswap v3 pool used as a price oracle
interface IUniswapV3PoolOracle {
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory);
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality,
        uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked);
}
