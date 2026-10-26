## Port it to your project

These prompts are for a coding agent (Claude Code or similar) working in **your** repository.
Each one points at the original files, pinned to the commits this page was built from, so the
agent reads the real rules rather than a summary of them. Run them in order. Each ends with
something you can review before the next.

Fill in the `<ANGLE_BRACKETS>` first. Nothing here assumes behaviour, neuroscience or a
particular model: the framework is about tracing every reported number back to the bytes, the
code and the compute it came from.

### What carries over, what to adapt, what to drop

| | |
|---|---|
| **Keep as is** | One launch mints one run group; every intervention (resubmit, rescue, extend, ...) joins it ([ADR 0001]({{studies}}/docs/adr/0001-one-launch-one-wandb-group.md)). An immutable launch record per submission. Freeze external data into the repo, then analyse offline. Input digests, not commits, tie a number to its inputs. Reports regenerated from committed inputs, numbers inside result blocks. Never retype another study's number. One checker as the only implementation of the rules, and a baseline of old findings that may only shrink. Three declared relationships between studies: motivation, upstream, correction ([ADR 0002]({{studies}}/docs/adr/0002-cross-study-relationships.md)). |
| **Adapt** | *Study naming* (`NN-{model}-{purpose}`) to your accession scheme. *W&B group* to your tracker's grouping (a W&B group, an MLflow experiment or run tag, a ClearML project). *Data snapshot* to your dataset identity (dataset version and manifest hash, DVC revision, Hugging Face dataset revision). *Image* to a container digest or an environment lock. *Commits per repository* to your repositories. *Tags* to your models and kinds of question. *Compute platforms* to your clusters and queues. |
| **Drop** | This project's tag values, Allen HPC partitions, the AI Hub cluster allowlist, project-board ids, and the sandbox git workaround. The `codebase-map` and `wrapper-runtime` skills describe this project's code: write your own. |

### 0 · Start here: assess and plan (no edits)

```text
You are helping adopt a provenance framework for ML experiments in this repository. The framework comes from the dynamic foraging behaviour foundation model project. Read its sources first:

- Vocabulary: {{studies}}/CONTEXT.md
- Decisions: {{studies}}/docs/adr/0001-one-launch-one-wandb-group.md and {{studies}}/docs/adr/0002-cross-study-relationships.md
- Schemas and what each governs: {{studies}}/schemas/README.md
- The rules for agents: {{studies}}/AGENTS.md

Then inspect THIS repository: how experiments are defined, how jobs are submitted (<YOUR_COMPUTE, e.g. Beaker, SLURM, Kubernetes>), how runs are tracked (<YOUR_TRACKER, e.g. W&B>), where data comes from, and how post-training analyses and reports are produced today.

Do not edit anything. Write PORTING_PLAN.md with:
1. A mapping table: each framework term (study, variant, launch, intervention, launch record, W&B group, freeze, frozen input, producer, analysis artifact, input digest, report, result block, upstream, correction) -> what it is called and where it lives here, or "missing".
2. For data, environment and code: how this repo could identify each immutably (dataset version or hash, container digest or lock file, commit SHAs).
3. The gaps, ranked by how much they put reported numbers at risk.
4. A staged plan following prompts 1-6 below, with what each stage changes. State what you verified in the code versus what you assume.
```

### 1 · Vocabulary and decisions

```text
Using PORTING_PLAN.md, write this repository's CONTEXT.md: a glossary in the format of {{studies}}/CONTEXT.md (bold term, one-paragraph definition, an _Avoid_ line naming the words people misuse for it). Rename the framework's terms only where this repo already has a settled name, and record the mapping in the definition. Keep the distinctions that carry the framework: a launch is not a run; an intervention keeps its launch's group; a freeze is the only code that reads a mutable source; a citation is not a relationship.

Then write docs/adr/0001 and 0002 for this repo, adapting the two ADRs above to your tracker and compute. Keep each ADR short: the decision, why, and what it rules out. Open a PR.
```

### 2 · Layout, schemas and one checker

```text
Add the machine-checked layer, modelled on {{studies}}/schemas/ and {{studies}}/scripts/check_provenance.py:

- schemas/layout.yaml: where studies, variants, launch records, analysis and reports live. Enforce only what tools read; leave the rest free (see the principle at the top of {{studies}}/schemas/layout.yaml).
- JSON Schemas, each with its own schema_version, for: study frontmatter ({{studies}}/schemas/study-frontmatter.v1.schema.json), report frontmatter ({{studies}}/schemas/report-frontmatter.v1.schema.json), the _meta block of every analysis JSON ({{studies}}/schemas/meta.v2.schema.json) and the launch record ({{studies}}/schemas/launch-record.v2.schema.json). Replace the project-specific repositories, data and image fields with the ones from your PORTING_PLAN.md mapping.
- schemas/tags.yaml with YOUR models and kinds of question.
- scripts/check_provenance.py: the ONLY implementation of the rules. Each finding gets a check id, a level, a path and a one-line fix. Support --format json.
- schemas/provenance-baseline.json: today's findings in existing files. The checker fails on any finding not in the baseline, and the baseline may only shrink except in a change that edits a schema or the checker.
- A scaffolder (make new-study / new-variant / new-report, like {{studies}}/scripts/scaffold.py) whose output passes the checker as written.
- A required CI job that runs the checker.

Write tests for the checker with a small fixture repository. Open a PR.
```

### 3 · Launch records on every compute platform

```text
Make every submission write a launch record that the checker can validate. Model it on {{studies}}/schemas/launch-record.v2.schema.json and {{studies}}/studies/util/launch_record.py, and on the launchers in {{dispatcher}}/code/provenance.py, {{dispatcher}}/code/launch_hpc.py and {{dispatcher}}/code/launch_beaker_resumable.py.

For each platform in <YOUR_COMPUTE>:
- The launcher refuses mutable refs for scientific runs: it resolves every repository to a full commit SHA and refuses a dirty study directory.
- It requires a label and a note saying why the run exists and what it should teach us.
- One launch mints exactly one run group in <YOUR_TRACKER>, named <variant>@<launch_id>, and every run of the launch joins it.
- It writes an immutable launch record: kind (initial or an intervention), platform, group, the manifests submitted (copied as submitted), job ids, commit per repository, the data identity and the image or environment digest.
- Interventions (resubmit, rescue, extend, tier change, backfill) write their own record, join the existing group, and list any field that differs from the launch under `deviations`. Any other change to scientific parameters is a new launch.

Never rewrite an existing record; a stale path in an old record is part of the record. Open a PR per platform.
```

### 4 · Freeze, then analyse offline; reports are code

```text
Restructure post-training analysis to the freeze-then-analyse pattern of {{dispatcher}}/aind-behavior-foundation-model-skills/skills/posthoc-reporting/SKILL.md:

- A freeze is the only code that reads a mutable source (<YOUR_TRACKER>, a dataset service, a URL). It pins the run groups it reads by exact name, never by search, and writes a committed frozen input recording which runs, at which step or version, it read.
- Every other producer reads only committed files. Each writes its JSON with a _meta block ({{studies}}/schemas/meta.v2.schema.json) built by one helper, like {{studies}}/studies/util/_meta.py: the producer and its code digests, every input by SHA-256, every output, the tracker groups, and the commit SHAs it ran from.
- Reports are markdown with frontmatter; their numbers live between BEGIN/END result-block markers that only the producer writes. Each report has a make target that regenerates it, and regenerating twice gives identical files.
- Never retype another study's number: read it from that study's committed JSON, pass that file as an input, and declare it in the report's `upstream`, so a correction there flags this report.
- Caches are gitignored and are never an input.

Migrate one existing analysis end to end as the worked example. Open a PR.
```

### 5 · Agent instructions and skills

```text
Write AGENTS.md for this repository in the style of {{studies}}/AGENTS.md: the required workflow (an issue before any tracked change, Conventional Commits, PRs, never squash), the provenance rules, and where the schemas and vocabulary live. AGENTS.md links to the schemas and CONTEXT.md rather than restating fields.

Then write skills for the recurring workflows, adapting these, which are marked general or site-specific on this page:
- {{dispatcher}}/aind-behavior-foundation-model-skills/skills/study-conventions/SKILL.md
- {{dispatcher}}/aind-behavior-foundation-model-skills/skills/posthoc-reporting/SKILL.md
- {{dispatcher}}/aind-behavior-foundation-model-skills/skills/beaker-launch/SKILL.md and {{dispatcher}}/aind-behavior-foundation-model-skills/skills/hpc-launch/SKILL.md, one per platform in <YOUR_COMPUTE>, with YOUR clusters, queues, capacity checks and credentials
- {{dispatcher}}/aind-behavior-foundation-model-skills/skills/issue-tracking/SKILL.md, with YOUR issue board

Keep each skill's "hard rules first" section, keep the why next to each rule, and replace every site-specific value. Write a fresh codebase map for this repository instead of adapting ours.
```

### 6 · Optional: an atlas for your studies

```text
Stand up a static, provenance-traced browser like https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-atlas: a build step that reads only committed files of the studies repository at one commit, embeds the checker's --format json output, and writes one catalog JSON that a static site renders (studies, reports, the lineage of each result block, provenance health). Keep the catalog a pure function of the commits it records, and check it against a JSON Schema in CI.
```

### All in one

For a first look, give an agent this single prompt instead:

```text
Adopt the ML provenance framework described at https://allenneuraldynamics.github.io/aind-dynamic-foraging-bfm-atlas/#/about in this repository. Read {{studies}}/CONTEXT.md, {{studies}}/schemas/README.md, {{studies}}/AGENTS.md and the two ADRs in {{studies}}/docs/adr/ first. Our compute is <YOUR_COMPUTE> and our tracker is <YOUR_TRACKER>. Start with a written plan mapping each framework term to this repo, and do not edit code until I approve it. Then proceed in stages: vocabulary, schemas and checker, launch records, freeze-then-analyse, agent instructions. Keep what the page marks "keep", adapt what it marks "adapt", and open one PR per stage.
```
