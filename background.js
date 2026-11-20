// The options page is only reachable from the gear behind the 5-second hold
// on the YouTube Focus logo (no toolbar click, no "Extension options" link).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'open-options') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});
