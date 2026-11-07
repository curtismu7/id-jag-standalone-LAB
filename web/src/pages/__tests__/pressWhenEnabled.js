import { fireEvent, screen, waitFor } from "@testing-library/react";

/**
 * Click a button once the page lets it be clicked.
 *
 * findByRole / getByRole match a DISABLED button too, and React drops a click on a disabled button without a trace. The playground
 * disables every action button until its config has loaded (`canRun`) and while another action is busy. Whether that state has been
 * rendered by the time a test clicks depends on how the event loop interleaves the mocked API's promise, React's scheduler task and
 * Testing Library's own timer, which a stalled worker (a loaded machine) reorders. A click that lands first is lost, nothing is sent,
 * and the test then waits in vain for the result. So: wait for the button to be enabled, then click it.
 */
export async function pressWhenEnabled(name, scope = screen) {
  await waitFor(() => expect(scope.getByRole("button", { name })).toBeEnabled());
  fireEvent.click(scope.getByRole("button", { name }));
}
