export function emptyWeek() {
  return Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map(d => [d, { l: null, d: null }]));
}
export function freshState() {
  return { people: 2, week: emptyWeek(), prep: [], got: {}, have: {}, mpOn: false, mpSlots: [], stock: [], wlunch: true,
    pantry: {}, pantryExtra: [], hidden: [], deleted: [], stacks: [], unstack: [], saved: true };
}

