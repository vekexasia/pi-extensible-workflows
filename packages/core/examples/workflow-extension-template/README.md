# Workflow extension template

This is a small, copyable extension rather than a generator. It shows the usual
registration shape with one function and generic agent hooks. Copy the directory
into a project, then rename the metadata and function.


## Run it

From the repository root after installing dependencies and building the package:

```sh
node --test packages/core/examples/workflow-extension-template/extension.test.mjs
```

For a published package, run the same test from this directory after installing
`pi-extensible-workflows` in the surrounding project. Copy the directory into a
trusted Pi extension location; Pi auto-discovers its `index.js` entry point.


## Files

- `index.js` registers `greet`, a model alias, and a setup hook with `registerWorkflowExtension`.
- `extension.test.mjs` checks registration, function behavior,
  and the advanced examples.


## Optional advanced pieces

The dynamic `template-model` alias and `templateAdvisor` setup hook are
optional examples. The hook only changes an agent after the call includes
`{ templateAdvisor: true }`; remove either section if the extension does not
need it. Both features are trusted host code and should be kept under explicit
project policy.
