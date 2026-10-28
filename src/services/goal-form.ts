export type GoalForm = { targetListening: number; targetReading: number; examDate: string; dailyMinutes: number };
export type GoalFormState = { value: GoalForm; dirty: boolean; saved: boolean };
type Action = { type: "change" | "sync" | "saved"; value: GoalForm };
const equal = (left: GoalForm, right: GoalForm) => left.targetListening === right.targetListening
  && left.targetReading === right.targetReading && left.examDate === right.examDate && left.dailyMinutes === right.dailyMinutes;

export function goalFormReducer(state: GoalFormState, action: Action): GoalFormState {
  if (action.type === "change") return { value: action.value, dirty: true, saved: false };
  if (action.type === "saved") {
    return equal(state.value, action.value) ? { ...state, dirty: false, saved: true } : state;
  }
  if (state.dirty || equal(state.value, action.value)) return state;
  return { value: action.value, dirty: false, saved: false };
}
