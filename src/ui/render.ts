/**
 * Terminal rendering. Deliberately a streaming log, not a differential TUI.
 *
 * px's default mode is unattended work inside a worktree, so the thing a human
 * needs is a readable trace they can scroll after the fact — not a repainting
 * full-screen app. `quiet` mode drops everything but the result, for scripts.
 */

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";

export interface UiOptions {
  quiet?: boolean;
  verbose?: boolean;
  color?: boolean;
}

export class Ui {
  private midStream = false;
  private readonly color: boolean;

  constructor(private readonly o: UiOptions = {}) {
    this.color = o.color ?? process.stdout.isTTY ?? false;
  }

  private c(code: string, s: string): string {
    return this.color ? `${code}${s}${RESET}` : s;
  }

  private endStream(): void {
    if (this.midStream) {
      process.stdout.write("\n");
      this.midStream = false;
    }
  }

  streamText(delta: string): void {
    if (this.o.quiet) return;
    process.stdout.write(delta);
    this.midStream = true;
  }

  toolStart(name: string): void {
    if (this.o.quiet) return;
    this.endStream();
    process.stdout.write(this.c(CYAN, `  ${name} `));
    this.midStream = true;
  }

  toolResult(name: string, summary: string, isError = false): void {
    if (this.o.quiet) return;
    this.endStream();
    const tag = isError ? this.c(RED, "!") : this.c(DIM, "·");
    console.log(`  ${tag} ${this.c(DIM, name)} ${this.c(DIM, summary)}`);
  }

  step(n: number, max: number, spentUsd: number, hitRate: number): void {
    if (this.o.quiet) return;
    this.endStream();
    console.log(
      this.c(DIM, `── step ${n}/${max}  $${spentUsd.toFixed(4)}  cache ${(hitRate * 100).toFixed(0)}%`),
    );
  }

  info(msg: string): void {
    if (this.o.quiet) return;
    this.endStream();
    console.log(msg);
  }

  debug(msg: string): void {
    if (!this.o.verbose) return;
    this.endStream();
    console.log(this.c(DIM, `  ${msg}`));
  }

  warn(msg: string): void {
    this.endStream();
    console.warn(this.c(YELLOW, `  ! ${msg}`));
  }

  error(msg: string): void {
    this.endStream();
    console.error(this.c(RED, `  ✗ ${msg}`));
  }

  success(msg: string): void {
    this.endStream();
    console.log(this.c(GREEN, `  ✓ ${msg}`));
  }

  heading(msg: string): void {
    if (this.o.quiet) return;
    this.endStream();
    console.log(this.c(BOLD, msg));
  }
}
