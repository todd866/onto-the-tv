const test = require('node:test');
const assert = require('node:assert/strict');
const { inStream } = require('../player.js');
test('Christmas includes reviewed seasonal episodes and family films without widening age streams', () => {
  const episode={title:'The Christmas Badge',src:'Duggee/a.mp4',tier:'shared',channel:'Hey Duggee'};
  const film={title:'Home Alone (1990)',src:'Family Films/a.mp4',tier:'big',channel:'Family Films'};
  assert.equal(inStream(episode,'christmas'),true);
  assert.equal(inStream(film,'christmas'),true);
  assert.equal(inStream(film,'2'),false);
  assert.equal(inStream({...episode,tier:'grownup'},'christmas'),false);
  assert.equal(inStream({...episode,title:'Ordinary Day'},'christmas'),false);
});
test('Movies includes reviewed film groups, not long compilations or adult films', () => {
  for(const tier of ['shared','big'])assert.equal(inStream({tier,channel:'Family Films'},'movies'),true);
  assert.equal(inStream({tier:'shared',channel:'Bluey',duration:7200},'movies'),false);
  assert.equal(inStream({tier:'grownup',channel:'Films'},'movies'),false);
});
