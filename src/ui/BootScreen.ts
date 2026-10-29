/**
 * 启动层：负责首屏进度与错误呈现。
 * 独立出来是因为它必须在 3D 初始化之前可用（渲染器创建失败也要能提示）。
 */
export class BootScreen {
  readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly msg: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'boot';
    this.el.innerHTML = `
      <div class="boot__brand">SMART WORKSHOP DIGITAL TWIN</div>
      <div class="boot__bar"><div class="boot__fill"></div></div>
      <div class="boot__msg">初始化渲染环境…</div>
    `;
    parent.appendChild(this.el);
    this.fill = this.el.querySelector('.boot__fill') as HTMLDivElement;
    this.msg = this.el.querySelector('.boot__msg') as HTMLDivElement;
  }

  progress(pct: number, message?: string): void {
    this.fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    if (message) this.msg.textContent = message;
  }

  fail(message: string): void {
    this.el.classList.remove('is-done');
    this.msg.textContent = message;
    this.msg.style.color = 'var(--bad)';
    this.fill.style.background = 'var(--bad)';
  }

  done(): void {
    this.progress(100);
    this.el.classList.add('is-done');
    setTimeout(() => this.el.remove(), 600);
  }

  dispose(): void {
    this.el.remove();
  }
}
