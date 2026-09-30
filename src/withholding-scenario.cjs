const validator = 5;
const stakePercent = 20;

function create(topology) {
  const others = topology.nodes.filter(n => n.role === 'validator' && n.id !== validator);
  const otherStake = others.reduce((sum, n) => sum + n.stake, 0);
  const nodes = topology.nodes.map(n => n.role !== 'validator' ? {...n} : {
    ...n,
    stake: n.id === validator ? stakePercent * otherStake : (100 - stakePercent) * n.stake,
  });
  return {topology: {...topology, nodes}, validator, stakePercent};
}

module.exports = {create};
