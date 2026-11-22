function waitForVideo(video, eventName, start) {
  return new Promise((resolve, reject) => {
    function done(error) {
      clearTimeout(timer);
      video.removeEventListener(eventName, success);
      video.removeEventListener("error", fail);
      if (error) reject(error);
      else resolve();
    }
    const success = () => done();
    const fail = () => done(new Error("浏览器无法解码这段视频，请使用可播放的视频文件。"));
    const timer = setTimeout(() => done(new Error("读取视频帧超时，请重新读取原视频。")), 20000);
    video.addEventListener(eventName, success, { once: true });
    video.addEventListener("error", fail, { once: true });
    try { start?.(); } catch (error) { done(error); }
  });
}

// Reading an already downloaded Blob keeps the canvas origin-clean, including
// after reloading a project. No network or generation request runs here.
export async function extractCanvasTailFrame(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("请先取得视频文件，再抽取尾帧。");
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await waitForVideo(video, "loadeddata", () => { video.src = url; });
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error("未读取到有效的视频时长或画面。");
    }
    // Seeking to the nominal endpoint can expose an empty/end-of-stream
    // surface. Pick the last millisecond inside the presentation interval.
    const target = Math.max(0, video.duration - 0.001);
    if (target > 0 && Math.abs(video.currentTime - target) > 0.0001) {
      await waitForVideo(video, "seeked", () => { video.currentTime = target; });
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持视频抽帧。");
    ctx.drawImage(video, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(frame => frame ? resolve(frame) : reject(new Error("保存尾帧时出错，请重试。")), "image/png");
    });
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
