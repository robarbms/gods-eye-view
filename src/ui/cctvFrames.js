export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

/**
 * Present an external still image (e.g. a clicked WSDOT traffic camera) inside
 * the CCTV panel's frame preview — the "palette". The snapshot borrows the
 * frame area until a live CCTV camera becomes active, at which point
 * `_renderCctvState` clears `_externalFrame` and the CCTV feed reclaims it.
 */
export function _showExternalFrame(detail) {
  if (this.destroyed || !detail?.imageUrl) return;
  this._externalFrame = {
    imageUrl: detail.imageUrl,
    title: detail.title || 'Traffic Camera',
    cameraId: `external:${detail.id ?? detail.imageUrl}`,
    source: detail.source || 'EXTERNAL',
    road: detail.road || null,
    milepost: Number.isFinite(detail.milepost) ? detail.milepost : null,
  };
  // The CCTV ("Cameras") layer auto-activates a default camera on enable, and a
  // live active camera reclaims the palette in _renderCctvState. Stand that
  // camera down so the clicked snapshot owns the frame until the operator
  // selects a CCTV camera again (which re-activates and reclaims normally).
  this.cctv?.deactivateActiveCamera?.();
  // Reveal the CCTV palette so the operator sees the snapshot immediately.
  this.actions?.setPanelCollapsed?.('cctv-panel', false, { explicit: true });
  this._renderExternalFrame();
}

/** Paint the active external snapshot into the frame, caption, and badge. */
export function _renderExternalFrame() {
  const ext = this._externalFrame;
  if (this.destroyed || !ext) return;
  // The still image takes the frame area; any live video surface yields.
  if (this._cctvVideo) this._cctvVideo.hidden = true;
  if (this._cctvFrame) this._cctvFrame.hidden = false;
  const cameraChanged = this._cctvFrame?.dataset.cameraId !== ext.cameraId;
  if (cameraChanged || this._cctvFrame?.dataset.currentSrc !== ext.imageUrl) {
    this._queueCctvFrame(ext.imageUrl, ext.cameraId, cameraChanged);
  }
  if (this._cctvMeta) {
    const parts = [ext.title];
    if (ext.road) parts.push(`SR ${ext.road}`);
    if (ext.milepost != null) parts.push(`MP ${ext.milepost}`);
    this._cctvMeta.textContent = parts.filter(Boolean).join(' · ');
  }
  this._syncCctvSourceBadge(null, false);
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  // An external snapshot (e.g. a WSDOT traffic camera) borrowing the palette
  // owns the badge while no live CCTV camera is active.
  if (this._externalFrame && !activeCamera) {
    const hasDisplayedFrame =
      this._cctvFrameWrap?.classList.contains('has-frame');
    if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
      this._cctvSourceBadge.textContent = 'FRAME · LOADING';
      this._cctvSourceBadge.dataset.frameState = 'loading';
      return;
    }
    if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
      this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
      this._cctvSourceBadge.dataset.frameState = 'error';
      return;
    }
    this._cctvSourceBadge.textContent = `${this._externalFrame.source || 'EXTERNAL'} · LIVE`;
    this._cctvSourceBadge.dataset.frameState = 'ready';
    return;
  }
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
