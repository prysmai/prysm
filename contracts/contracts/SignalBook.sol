// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IIdentityRegistry, IReputationRegistry, IUniswapV3PoolOracle} from "./Interfaces.sol";

/// @title PRYSM SignalBook - commit-reveal trading signals scored by Uniswap v3 TWAP, written to ERC-8004 reputation
/// @notice An ERC-8004 agent commits a hash of (asset, direction, horizon, salt). After the horizon it reveals; the contract
/// scores the call itself as the log-return (in ticks, ~1 bp each) between the 5-minute TWAP right after the commit and the
/// 5-minute TWAP right after expiry, signed by direction and capped. A signal left unrevealed past the window can be
/// forfeited by anyone and scores the cap as a loss, so committing both sides and revealing the winner never pays.
/// A call whose oracle window is gone is void (no score) only if it was revealed promptly; a late reveal that finds the
/// window gone scores the cap as a loss, so letting a losing call age out (or helping it) never pays either.
contract SignalBook is Ownable {
    using SafeERC20 for IERC20;

    struct Asset { address pool; bool invert; bool active; string symbol; }
    struct Signal {
        uint256 agentId; bytes32 commitHash; uint64 committedAt; uint8 status;
        uint16 assetId; int8 dir; uint32 horizon; int32 scoreBps;
    }
    struct Stats { uint32 open; uint32 settled; uint32 wins; uint32 forfeits; uint32 voids; int64 sumBps; uint128 sumSqBps; }

    uint8 public constant OPEN = 0;
    uint8 public constant SETTLED = 1;
    uint8 public constant FORFEITED = 2;
    uint8 public constant VOID = 3;          // the oracle window had rotated out: no score either way

    uint32 public constant TWAP = 300;
    uint32 public constant REVEAL_WINDOW = 3600;
    int32 public constant CAP = 1000;        // +-10% per call
    uint32 public constant MAX_OPEN = 24;
    uint256 public constant FEEDBACK_GAS = 450_000;
    uint32 public constant VOID_GRACE = 600;     // a void is only neutral if the call was revealed this soon after it became due
    uint32 public constant MAX_HORIZON = 1 days;

    IIdentityRegistry public immutable identity;
    IReputationRegistry public immutable reputation;
    IERC20 public immutable token;
    address public treasury;
    uint256 public enrollFee;
    bool public feedbackOn = true;
    uint32 public maxHorizon = 4 hours;
    uint16 public minCardinality = 7200;      // oracle slots a pool must keep, so its history is costly to flush

    Asset[] public assets;
    mapping(uint32 => bool) public horizonOk;
    // config changes after a commit void that call instead of re-scoring or stranding it
    mapping(uint16 => uint64) public assetUpdatedAt;
    mapping(uint32 => uint64) public horizonUpdatedAt;
    mapping(uint256 => address) public committedOwner;   // the identity's owner at commit time
    Signal[] public signals;
    mapping(uint256 => bool) public enrolled;
    mapping(uint256 => Stats) public stats;
    uint256[] public agents;

    event Enrolled(uint256 indexed agentId, address indexed by);
    event Committed(uint256 indexed signalId, uint256 indexed agentId, bytes32 commitHash);
    event Settled(uint256 indexed signalId, uint256 indexed agentId, uint16 assetId, int8 dir, uint32 horizon, int32 scoreBps,
        int24 entryTick, int24 exitTick);
    event Forfeited(uint256 indexed signalId, uint256 indexed agentId);
    event Voided(uint256 indexed signalId, uint256 indexed agentId);
    event AssetSet(uint16 indexed assetId, address pool, bool invert, bool active, string symbol);
    event FeedbackFailed(uint256 indexed signalId, uint256 indexed agentId, int32 scoreBps);

    error NotAgent();
    error NotEnrolled();
    error TooManyOpen();
    error BadStatus();
    error TooEarly();
    error TooLate();
    error BadReveal();
    error BadAsset();
    error BadHorizon();
    error LowGas();
    error ThinOracle();

    constructor(address identity_, address reputation_, address token_, address treasury_, uint256 enrollFee_)
        Ownable(msg.sender)
    {
        identity = IIdentityRegistry(identity_);
        reputation = IReputationRegistry(reputation_);
        token = IERC20(token_);
        treasury = treasury_;
        enrollFee = enrollFee_;
        horizonOk[15 minutes] = true;
        horizonOk[1 hours] = true;
        horizonOk[4 hours] = true;
    }

    // ---------- admin ----------
    function setAsset(uint16 assetId, address pool, bool invert, bool active, string calldata symbol) external onlyOwner {
        if (assetId == assets.length) assets.push();
        else if (assetId > assets.length) revert BadAsset();
        if (active) {
            (,,, uint16 card,,,) = IUniswapV3PoolOracle(pool).slot0();
            if (card < minCardinality) revert ThinOracle();
        }
        assets[assetId] = Asset(pool, invert, active, symbol);
        assetUpdatedAt[assetId] = uint64(block.timestamp);
        emit AssetSet(assetId, pool, invert, active, symbol);
    }
    function setHorizon(uint32 h, bool ok) external onlyOwner {
        if (h == 0 || h > MAX_HORIZON) revert BadHorizon();
        horizonOk[h] = ok;
        horizonUpdatedAt[h] = uint64(block.timestamp);
        if (ok && h > maxHorizon) maxHorizon = h;
    }
    function setMinCardinality(uint16 c) external onlyOwner { minCardinality = c; }
    function setEnrollFee(uint256 fee) external onlyOwner { enrollFee = fee; }
    function setTreasury(address t) external onlyOwner { treasury = t; }
    function setFeedback(bool on) external onlyOwner { feedbackOn = on; }

    // ---------- agents ----------
    function isAgentOperator(uint256 agentId, address who) public view returns (bool) {
        if (identity.ownerOf(agentId) == who) return true;
        try identity.getAgentWallet(agentId) returns (address w) { return w != address(0) && w == who; } catch { return false; }
    }

    function enroll(uint256 agentId) external {
        if (!isAgentOperator(agentId, msg.sender)) revert NotAgent();
        if (enrolled[agentId]) return;
        enrolled[agentId] = true;
        agents.push(agentId);
        if (enrollFee > 0) token.safeTransferFrom(msg.sender, treasury, enrollFee);
        emit Enrolled(agentId, msg.sender);
    }

    function hashSignal(uint256 agentId, uint16 assetId, int8 dir, uint32 horizon, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, agentId, assetId, dir, horizon, salt));
    }

    function commit(uint256 agentId, bytes32 commitHash) external returns (uint256 id) {
        if (!enrolled[agentId]) revert NotEnrolled();
        if (!isAgentOperator(agentId, msg.sender)) revert NotAgent();
        Stats storage s = stats[agentId];
        if (s.open >= MAX_OPEN) revert TooManyOpen();
        s.open++;
        id = signals.length;
        signals.push(Signal(agentId, commitHash, uint64(block.timestamp), OPEN, 0, 0, 0, 0));
        committedOwner[id] = identity.ownerOf(agentId);
        emit Committed(id, agentId, commitHash);
    }

    /// @notice Anyone holding the plaintext may reveal (the MCP relay reveals for agents that went offline).
    function reveal(uint256 id, uint16 assetId, int8 dir, uint32 horizon, bytes32 salt) external {
        Signal storage g = signals[id];
        if (g.status != OPEN) revert BadStatus();
        if (hashSignal(g.agentId, assetId, dir, horizon, salt) != g.commitHash) revert BadReveal();
        if (assetId >= assets.length) revert BadAsset();
        if ((dir != 1 && dir != -1) || horizon == 0 || horizon > MAX_HORIZON) revert BadHorizon();
        uint256 expiry = g.committedAt + horizon;
        if (block.timestamp < expiry + TWAP) revert TooEarly();
        if (block.timestamp > expiry + TWAP + REVEAL_WINDOW) revert TooLate();
        // the owner changed this asset or horizon after the commit: the call is void, not re-scored on new terms
        bool changed = assetUpdatedAt[assetId] > g.committedAt || horizonUpdatedAt[horizon] > g.committedAt;
        if (!changed && !assets[assetId].active) revert BadAsset();
        if (!changed && !horizonOk[horizon]) revert BadHorizon();
        g.assetId = assetId; g.dir = dir; g.horizon = horizon;
        Stats storage s = stats[g.agentId];
        s.open--;
        if (changed) { _void(id, g, s); return; }
        _settle(id, g, s, expiry);
    }

    function _settle(uint256 id, Signal storage g, Stats storage s, uint256 expiry) internal {
        Asset storage a = assets[g.assetId];
        (bool ok, int24 t0, int24 t1) = _twaps(a.pool, g.committedAt, expiry);
        if (!ok) {
            // only a prompt reveal may find the window gone without penalty; waiting for it to rotate out is a forfeit
            if (block.timestamp > expiry + TWAP + VOID_GRACE) { _forfeit(id, g, s); return; }
            _void(id, g, s); return;
        }
        int256 move = int256(t1) - int256(t0);
        if (a.invert) move = -move;
        int256 sc = move * g.dir;
        if (sc > CAP) sc = CAP;
        if (sc < -CAP) sc = -CAP;
        g.status = SETTLED; g.scoreBps = int32(sc);
        s.settled++;
        if (sc > 0) s.wins++;
        s.sumBps += int64(sc);
        s.sumSqBps += uint128(uint256(sc * sc));
        emit Settled(id, g.agentId, g.assetId, g.dir, g.horizon, int32(sc), t0, t1);
        _feedback(id, g.agentId, int32(sc), a.symbol, g.commitHash);
    }

    function forfeit(uint256 id) external {
        Signal storage g = signals[id];
        if (g.status != OPEN) revert BadStatus();
        // horizons are hidden until reveal, so a forfeit waits until even the longest one's reveal window has closed
        if (block.timestamp <= g.committedAt + maxHorizon + TWAP + REVEAL_WINDOW) revert TooEarly();
        Stats storage s = stats[g.agentId];
        s.open--;
        // the identity changed hands while the call was open: the new owner never had the salt, so it is not their loss
        if (identity.ownerOf(g.agentId) != committedOwner[id]) { _void(id, g, s); return; }
        _forfeit(id, g, s);
    }

    function _forfeit(uint256 id, Signal storage g, Stats storage s) internal {
        g.status = FORFEITED; g.scoreBps = -CAP;
        s.forfeits++; s.settled++;
        s.sumBps -= int64(CAP);
        s.sumSqBps += uint128(uint256(int256(CAP) * CAP));
        emit Forfeited(id, g.agentId);
        _feedback(id, g.agentId, -CAP, "forfeit", g.commitHash);
    }

    function _void(uint256 id, Signal storage g, Stats storage s) internal {
        g.status = VOID; s.voids++;
        emit Voided(id, g.agentId);
    }

    function _twaps(address pool, uint256 committedAt, uint256 expiry) internal view returns (bool, int24, int24) {
        uint32[] memory ago = new uint32[](4);
        uint256 nowTs = block.timestamp;
        // entry: [commit, commit+TWAP], exit: [expiry, expiry+TWAP]
        ago[0] = uint32(nowTs - committedAt);
        ago[1] = uint32(nowTs - committedAt - TWAP);
        ago[2] = uint32(nowTs - expiry);
        ago[3] = uint32(nowTs - expiry - TWAP);
        try IUniswapV3PoolOracle(pool).observe(ago) returns (int56[] memory c, uint160[] memory) {
            int24 t0 = int24((c[1] - c[0]) / int56(uint56(TWAP)));
            int24 t1 = int24((c[3] - c[2]) / int56(uint56(TWAP)));
            return (true, t0, t1);
        } catch {
            return (false, 0, 0);
        }
    }

    function _feedback(uint256 id, uint256 agentId, int32 sc, string memory tag2, bytes32 h) internal {
        if (!feedbackOn || address(reputation) == address(0)) return;
        // a try/catch lets gas estimation settle on a limit where the inner call quietly runs out of gas;
        // demanding the headroom up front makes estimates (and wallets) include it
        if (gasleft() < FEEDBACK_GAS) revert LowGas();
        // a failure is public (e.g. the registry refusing feedback while the agent has approved this contract), so an
        // agent cannot quietly keep its losses out of its ERC-8004 record; the score itself is final either way
        try reputation.giveFeedback{gas: FEEDBACK_GAS - 20_000}(agentId, int128(sc), 2, "prysm/alpha", tag2, "", "", h) {}
        catch { emit FeedbackFailed(id, agentId, sc); }
    }

    // ---------- views ----------
    function signalCount() external view returns (uint256) { return signals.length; }
    function assetCount() external view returns (uint256) { return assets.length; }
    function agentCount() external view returns (uint256) { return agents.length; }
}
