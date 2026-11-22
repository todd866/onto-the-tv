const test = require('node:test');
const assert = require('node:assert/strict');
const { inStream, inChristmasAdult } = require('../player.js');
test('Christmas includes reviewed seasonal episodes and family films without widening age streams', () => {
  const episode={title:'The Christmas Badge',src:'Duggee/a.mp4',tier:'shared',channel:'Hey Duggee'};
  const film={title:'Home Alone (1990)',src:'Family Films/a.mp4',tier:'big',channel:'Family Films'};
  assert.equal(inStream(episode,'christmas'),true);
  assert.equal(inStream(film,'christmas'),true);
  assert.equal(inStream(film,'2'),false);
  assert.equal(inStream({...episode,tier:'grownup'},'christmas'),false);
  assert.equal(inStream({...episode,title:'Ordinary Day'},'christmas'),false);
  // Festive titles whose name carries no seasonal word (2026 intake).
  for(const title of ['Elf (2003)','The Grinch (2018)','Klaus (2019)','The Polar Express (2004)','Christmas with the Kranks (2005)'])
    assert.equal(inStream({title,src:'Family Films/k.mp4',tier:'big',channel:'Family Films'},'christmas'),true);
  assert.equal(inStream({title:'Klaus (2019)',src:'Family Films/k.mp4',tier:'grownup',channel:'Films'},'christmas'),false);
  assert.equal(inStream({title:'Jingle All the Way (1996)',src:'Family Films/j.mp4',tier:'big',channel:'Family Films'},'christmas'),true);
  // Adult Christmas films join the pool only by reviewed title, tier and folder,
  // and the family stream itself still refuses them.
  assert.equal(inStream({title:'Bad Santa (2003)',src:'Films/b.mp4',tier:'grownup',channel:'Films'},'christmas'),false);
  assert.equal(inStream({title:'Violent Night (2022)',src:'Films/v.mp4',tier:'grownup',channel:'Films'},'christmas'),false);
  for(const title of ['Bad Santa (2003)','Die Hard 2 (1990)','Violent Night (2022)','Fatman (2020)','Love Actually (2003)'])
    assert.equal(inChristmasAdult({title,src:'Films/x.mp4',tier:'grownup',channel:'Films'}),true);
  // An adult title with a seasonal word stays out unless reviewed.
  assert.equal(inChristmasAdult({title:'Kiss Kiss Bang Bang (2005)',src:'Films/k.mp4',tier:'grownup',channel:'Films'}),false);
  assert.equal(inChristmasAdult({title:'Bad Santa (2003)',src:'Family Films/b.mp4',tier:'big',channel:'Family Films'}),false);
});
test('Movies includes reviewed film groups, not long compilations or adult films', () => {
  for(const tier of ['shared','big'])assert.equal(inStream({tier,channel:'Family Films'},'movies'),true);
  assert.equal(inStream({tier:'shared',channel:'Bluey',duration:7200},'movies'),false);
  assert.equal(inStream({tier:'grownup',channel:'Films'},'movies'),false);
});
