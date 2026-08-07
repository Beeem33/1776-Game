// Keyboard + mouse state. Mouse deltas accumulate between frames and are
// consumed once per update by the camera controller.
export class Input {
  constructor() {
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.fireHeld = false;
    this.pointerLocked = false;

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.fireHeld = false;
    });

    this.mouseX = window.innerWidth / 2;
    this.mouseY = window.innerHeight / 2;
    this.wheelDelta = 0;

    window.addEventListener('wheel', (e) => {
      this.wheelDelta += e.deltaY;
    }, { passive: true });

    document.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('mousedown', (e) => {
      if (this.pointerLocked && e.button === 0) this.fireHeld = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
  }

  isDown(code) {
    return this.keys.has(code);
  }

  // Mouse position in normalized device coordinates (for cursor-aimed fire)
  getMouseNDC() {
    return {
      x: (this.mouseX / window.innerWidth) * 2 - 1,
      y: -((this.mouseY / window.innerHeight) * 2 - 1),
    };
  }

  consumeWheel() {
    const d = this.wheelDelta;
    this.wheelDelta = 0;
    return d;
  }

  consumeMouseDelta() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }
}
