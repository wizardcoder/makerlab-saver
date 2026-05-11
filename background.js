// MakerLab Config Saver — Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  console.log("[MakerLab Saver] Extension installed.");
  chrome.storage.local.get({ savedConfigs: [] }, (data) => {
    console.log(`[MakerLab Saver] ${data.savedConfigs.length} saved configs found.`);
  });
});
