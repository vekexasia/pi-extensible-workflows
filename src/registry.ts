/** Registry implementation boundary. The host barrel owns the shared registry instance. */
export {
  registerWorkflowExtension,
  registeredWorkflowFunctions,
  workflowCatalog,
  workflowCatalogDetail,
  workflowCatalogIndex,
  WorkflowRegistry,
} from "./index.js";
export type {
  WorkflowCatalog,
  WorkflowCatalogError,
  WorkflowCatalogFunction,
  WorkflowCatalogIndex,
  WorkflowCatalogIndexFunction,
  WorkflowCatalogIndexVariable,
  WorkflowCatalogVariable,
} from "./types.js";