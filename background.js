// jobApplier service worker — the toolbar icon opens the side panel; that's all it does.
// The click that opens the panel also grants activeTab on that tab, which is what lets
// the panel inject content-ats.js on career pages outside the declared ATS hosts.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn("jobApplier: panel behavior failed", e));
