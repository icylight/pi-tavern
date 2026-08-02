/**
 * #60：运行中增量聚合窗口（固定窗口，有界延迟）。
 *
 * 形态：自包含小助手——首个通知开启窗口、窗口内通知合并（仅计数）、
 * 窗口末 flush 一次、可取消。纯状态 + 注入回调，假定时器可测。
 *
 * Phase 2 汇合点：窗口逻辑 = steer 决策策略的雏形（何时聚合、何时投递），
 * 属 ADR 决策 7「决策归 application/character-pipelines」——届时整块搬移，
 * characterize-first 钉测零改写。
 */
export class AggregationWindow {
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly onFlush: () => void,
		private readonly windowMs: number,
	) {}

	/** 首个通知开启窗口；窗口内后续通知并入本次 flush（不重置计时）。 */
	notify(): void {
		if (this.timer !== null) {
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			this.onFlush();
		}, this.windowMs);
	}

	/** 取消未到期窗口（settle/停止时；settle 钩子自会补拉尾部）。 */
	cancel(): void {
		if (this.timer === null) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = null;
	}
}
