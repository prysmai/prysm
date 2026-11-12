// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Prysm Test", "tNDR") { _mint(msg.sender, 1_000_000_000 ether); }
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract MockIdentity {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getAgentWallet;
    mapping(uint256 => string) public tokenURI;
    uint256 public next = 1;
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    function register() external returns (uint256 id) { id = next++; ownerOf[id] = msg.sender; emit Registered(id, "", msg.sender); }
    function register(string calldata uri) external returns (uint256 id) {
        id = next++; ownerOf[id] = msg.sender; tokenURI[id] = uri; emit Registered(id, uri, msg.sender);
    }
    function setWallet(uint256 id, address w) external { require(ownerOf[id] == msg.sender); getAgentWallet[id] = w; }
    function transfer(uint256 id, address to) external { require(ownerOf[id] == msg.sender); ownerOf[id] = to; getAgentWallet[id] = address(0); }
}

contract MockReputation {
    struct F { uint256 agentId; int128 value; uint8 dec; string tag1; string tag2; address client; }
    F[] public feedback;
    bool public fail;
    function setFail(bool f) external { fail = f; }
    function giveFeedback(uint256 agentId, int128 value, uint8 dec, string calldata tag1, string calldata tag2,
        string calldata, string calldata, bytes32) external {
        require(!fail, "refused");
        feedback.push(F(agentId, value, dec, tag1, tag2, msg.sender));
    }
    function count() external view returns (uint256) { return feedback.length; }
    function getSummary(uint256 agentId, address[] calldata, string calldata, string calldata) external view returns (uint64 n, int128 v, uint8 d) {
        for (uint256 i; i < feedback.length; i++) if (feedback[i].agentId == agentId) { n++; v += feedback[i].value; }
        d = 2;
    }
}

/// piecewise-linear tick path: each setPath starts a new segment at the current time; observe integrates the history
contract MockPool {
    struct Seg { uint256 t; int256 tick; int256 slope; int256 cum; }
    Seg[] public segs;
    uint32 public maxAge = type(uint32).max;
    function setPath(int24 tick, int256 slope) external {
        int256 c = segs.length == 0 ? int256(0) : cumAt(block.timestamp);
        segs.push(Seg(block.timestamp, tick, slope, c));
    }
    function setMaxAge(uint32 a) external { maxAge = a; }
    uint16 public cardinality = 7200;
    function setCardinality(uint16 c) external { cardinality = c; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) { return (0, 0, 0, cardinality, cardinality, 0, true); }
    function cumAt(uint256 t) public view returns (int256) {
        uint256 i = segs.length - 1;
        while (i > 0 && segs[i].t > t) i--;
        Seg storage g = segs[i];
        int256 dt = int256(t) - int256(g.t);
        return g.cum + g.tick * dt + g.slope * dt * dt / 2;
    }
    function observe(uint32[] calldata ago) external view returns (int56[] memory c, uint160[] memory l) {
        c = new int56[](ago.length); l = new uint160[](ago.length);
        for (uint256 i; i < ago.length; i++) {
            require(ago[i] <= maxAge, "OLD");
            c[i] = int56(cumAt(block.timestamp - ago[i]));
        }
    }
}
