// On-screen joystick + jump button for touch devices. Orbiting stays on the canvas itself.
export const touch = { x: 0, y: 0, jump: false };

export const setupTouch = () => {
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  document.documentElement.classList.add('touch');

  const pad = document.createElement('div');
  pad.className = 'touch-pad';
  const knob = document.createElement('div');
  knob.className = 'touch-knob';
  pad.appendChild(knob);
  const jump = document.createElement('div');
  jump.className = 'touch-jump';
  jump.textContent = 'JUMP';
  document.body.append(pad, jump);

  let padId: number | null = null;
  const RANGE = 42;
  const updatePad = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > RANGE) { dx *= RANGE / len; dy *= RANGE / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    touch.x = dx / RANGE;
    touch.y = dy / RANGE;
  };
  const releasePad = () => {
    padId = null;
    touch.x = 0;
    touch.y = 0;
    knob.style.transform = '';
  };
  pad.addEventListener('pointerdown', (e) => {
    padId = e.pointerId;
    pad.setPointerCapture(e.pointerId);
    updatePad(e);
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === padId) updatePad(e); });
  pad.addEventListener('pointerup', releasePad);
  pad.addEventListener('pointercancel', releasePad);

  const setJump = (on: boolean) => {
    touch.jump = on;
    jump.classList.toggle('active', on);
  };
  jump.addEventListener('pointerdown', (e) => { jump.setPointerCapture(e.pointerId); setJump(true); });
  jump.addEventListener('pointerup', () => setJump(false));
  jump.addEventListener('pointercancel', () => setJump(false));
};
