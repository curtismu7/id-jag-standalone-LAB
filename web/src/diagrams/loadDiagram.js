import { validateDiagram } from "./diagramSchema";

// The diagrams are diagram-studio/1 data files in <repo>/diagrams/, vendored from the diagram-studio data format.
// They are loaded by name; the page builds the ReactFlow graph from this data and nothing is hand-built in code.
const FILES = import.meta.glob("../../../diagrams/*.json", { eager: true, import: "default" });
const BY_NAME = new Map(Object.entries(FILES).map(([path, data]) => [path.split("/").pop().replace(/\.json$/, ""), data]));

export const diagramNames = () => [...BY_NAME.keys()];

/** The diagram called `name`, or null when there is none or the file is not a valid diagram-studio/1 diagram. */
export function loadDiagram(name) {
  const data = typeof name === "string" ? BY_NAME.get(name) : undefined;
  return data && validateDiagram(data).length === 0 ? data : null;
}
