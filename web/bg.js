/* Background videos for the TV dashboard.
 * Plays the clips listed in videos/manifest.json, one at a time on a loop.
 * The remote switches clips: the page calls window.bgVideo("next" | "prev")
 * (Down / Up on the remote). The last clip chosen is remembered across restarts.
 */
(function () {
  var root = document.getElementById("bgRoot");
  var video = document.createElement("video");
  video.className = "bgvid";
  video.muted = true; video.loop = true; video.autoplay = true;
  video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
  root.appendChild(video);

  var videos = [], current = 0;

  function playAt(i) {
    current = (i + videos.length) % videos.length;
    try { localStorage.setItem("bgVideo", String(current)); } catch (e) {}
    var hadVideo = !!video.getAttribute("src");
    video.style.opacity = 0;                       // fade out, swap, fade back in
    setTimeout(function () {
      video.src = "videos/" + encodeURIComponent(videos[current]);
      video.oncanplay = function () { video.style.opacity = 1; };
      var p = video.play(); if (p && p.catch) p.catch(function () {});
    }, hadVideo ? 700 : 0);
  }

  fetch("videos/manifest.json", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : []; })
    .catch(function () { return []; })
    .then(function (list) {
      videos = (list || []).slice().sort();
      if (!videos.length) return;                   // no clips: the plain gradient background stays
      var saved = 0;
      try { saved = parseInt(localStorage.getItem("bgVideo") || "0", 10) || 0; } catch (e) {}
      playAt(saved);
      window.bgVideo = function (cmd) { playAt(current + (cmd === "prev" ? -1 : 1)); };
    });
})();
