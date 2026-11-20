/** A stored Tasks view with the details pane open: inspector tests read the pane body. */
export const openedTaskView = () => ({
  scope: "session" as const,
  selectedID: null,
  search: "",
  detailScroll: 0,
  history: false,
  revealTaskID: "",
  open: true,
})
