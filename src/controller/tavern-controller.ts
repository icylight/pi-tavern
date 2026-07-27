export type TavernState = { type: "idle" };

export class TavernController {
	private readonly state: TavernState = { type: "idle" };

	getState(): TavernState {
		return this.state;
	}
}
