# Scout D: prior art for overnight dreaming and daytime proactivity

Pinned question: which published mechanisms and shipped products cover (a) offline consolidation of agent memory and (b) timely, low-annoyance proactive action, and what design patterns follow for a single-user personal agent (ky). Surveyed as of 2026-10-16.

## Summary

1. Offline consolidation has a published basis: Letta's sleep-time agents and the sleep-time compute paper (arXiv 2504.13171, Apr 2025) precompute from context while the user is idle, reporting about 5x less test-time compute and up to 2.5x lower cost per query when queries share context. Generative Agents (Park et al., 2023) gives the reflection trigger (summed importance over 150) and the importance score.
2. Shipped products converge on "nightly background research, delivered as a short set of cards, dismissible, with feedback": ChatGPT Pulse (preview from 25 Sep 2025) is the clearest example. Claude memory is the opposite pattern: incremental, per-topic, editable, and per-project.
3. Proactive timing is the weak point in the evidence. The Proactive Agent paper (ICLR 2025) finds that even the best model has a 50.22% false-alarm rate, and most baseline models over-assist. Interruption-timing work supports deferring to task boundaries, but the 2025-2026 LLM-specific evidence is thin.
4. Privacy is the main failure mode in the market: Microsoft Recall was delayed and redesigned after backlash over unencrypted screenshots; Rewind/Limitless was acquired by Meta (5 Dec 2025) and its capture shut down (19 Dec 2025). Always-on capture lost trust; user-visible, opt-in, bounded inputs held up better.
5. Recommendation: treat proactivity as a budgeted, silent-by-default, feedback-driven pipeline. Precompute the nightly brief and the next-session context; surface at most a few items; gate interruptions on task boundaries and on user-set quiet hours; log every surfaced item with a dismiss or act signal so the threshold can be tuned.

Verification legend: **checked** = read the primary page this session; **snippet** = seen only in search-result text, not fetched; **inferred** = my reasoning from the sources.

---

## 1. Offline / sleep-time consolidation

### 1a. Sleep-time compute (Lin, Snell, Packer et al.; Letta and UC Berkeley)
- Source: arXiv 2504.13171, submitted 17 Apr 2025 ([abstract](https://arxiv.org/abs/2504.13171), **checked**).
- Mechanism: while idle, the model reasons over a stored context and writes derived knowledge; later queries against that context need less test-time reasoning. Trigger: idle time, not a user request. Precomputed: inferences about the context. Surfaced: indirectly, as better answers at query time.
- Reported (abstract, **checked**): about 5x less test-time compute for the same accuracy on Stateful GSM-Symbolic and Stateful AIME; accuracy up to +13% (GSM-Symbolic) and +18% (AIME) when sleep-time compute is scaled; about 2.5x lower average cost per query on Multi-Query GSM-Symbolic when one context is amortized across related queries. The abstract says the efficacy is "well correlated" with how predictable the user query is from the context.
- Worked: amortization across many queries on the same context. Failed or weaker: unpredictable queries (the paper's own correlation; inferred that this is the failure mode).
- Caveat: these are benchmark results on math-style tasks, not personal-memory tasks.

### 1b. Letta sleep-time agents (product implementation)
- Source: [Letta blog, 21 Apr 2025](https://letta.com/blog/sleep-time-compute) (**checked**).
- Mechanism: creating a sleep-time agent creates two agents. The primary agent talks to the user and has no tool to edit its own core memory. The sleep-time agent holds those tools and edits both its own and the primary's in-context memory blocks. Edits are "anytime": the primary reads whatever is there without waiting for a sleep-time run to finish. Run frequency is configurable; higher frequency costs more tokens and gives more revision time.
- Precomputed: cleaned, condensed memories; parsed uploaded documents; findings written into the primary's memory blocks.
- Model split: the page suggests a cheap fast model for the primary and a larger model for the sleep-time agent.
- Worked: separating "talk now" from "reorganize memory" so the user-facing path stays fast. Failed or open: the page gives no quantitative results and does not describe the trigger in detail (**checked**: no numbers on the page).

### 1c. Generative Agents reflection and importance (Park et al., 2023)
- Source: arXiv 2304.03442, [HTML v2](https://arxiv.org/html/2304.03442v2) (**checked**).
- Mechanism: each memory gets an LLM-assigned importance score on a 1-10 scale (1 = "purely mundane", 10 = "extremely poignant (e.g., a break up, college acceptance)"). When summed importance of recent memories exceeds **150** (the paper's implementation value), the agent reflects. Reflection is two steps: generate 3 high-level questions from recent memories, then answer with 5 insights, each citing the memory IDs it rests on, e.g. "insight (because of 1, 5, 3)". Reflections are stored back into the memory stream as first-class memories.
- Retrieval: score = weighted sum of recency, importance, and relevance (embedding cosine). The paper sets all weights to 1 (**checked**). A secondary site reports hand-tuned weights of 0.5/3.0/2.0; that conflicts with the paper, and I did not check the reference repo, so treat it as unverified.
- Worked: the importance-threshold trigger means reflection happens when something happened, not on a clock. Citation pointers make reflections auditable. Ablation (paper abstract, **checked**): observation, planning, and reflection each contribute to believability.
- Failure modes: importance scoring is LLM-judged and can drift; the paper's setting is a simulation, not a real user.

### 1d. Mem0 (Chhikara et al., Apr 2025)
- Source: [arXiv 2504.19413](https://arxiv.org/abs/2504.19413) (snippet). Mechanism: extract salient facts from each conversation turn, dedupe and update against an existing store, optional graph variant.
- Reported (snippet, authors' own benchmark on LOCOMO): 91% lower p95 latency and over 90% token cost savings versus full-context; about 7k tokens per conversation for the base store and about 14k for the graph variant versus about 26k for raw conversation. Vendor blog figures differ slightly. Treat as self-reported.
- Relevance to ky: extraction at write time, not at night, so it is the closest to "consolidate continuously" rather than "consolidate overnight".

### 1e. A-MEM (Xu et al., NeurIPS 2025)
- Source: [arXiv 2502.12110](https://arxiv.org/html/2502.12110v9) (snippet; NeurIPS 2025 accepted).
- Mechanism: each new memory becomes a structured note (context, keywords, tags); the system links it to related past notes; adding a new note can update older notes' attributes ("memory evolution"). Trigger: write time.
- Worked: notes that get re-written as new evidence arrives, instead of append-only logs. Failure mode: a bad new note can silently rewrite old ones; needs provenance (inferred).

### 1f. Zep / Graphiti (Rasmussen et al., Jan 2025)
- Source: [arXiv 2501.13956](https://arxiv.org/html/2501.13956v1) (snippet).
- Mechanism: a temporal knowledge graph where facts carry validity intervals and the system keeps when an event occurred vs. when it was ingested (bi-temporal). Old facts are invalidated, not deleted.
- Reported (snippet, self-reported): 94.8% on Deep Memory Retrieval vs 93.4% for MemGPT; up to 18.5% accuracy gain and about 90% latency cut on LongMemEval. Mem0's paper disputes Zep's token cost (snippet).
- Relevance to ky: the bi-temporal, invalidate-don't-delete model is directly useful for "this preference changed last month" in dreaming output.

---

## 2. Product proactivity

### 2a. ChatGPT Pulse (OpenAI, preview from 25 Sep 2025)
- Mechanism (snippet, secondary coverage): a daily background research run over chat history, memory, and feedback; output is visual cards the next morning, 5-10 cards per the coverage; cards expire at end of day unless saved. Optional Gmail and Calendar connectors, off by default per coverage.
- Help article (https://help.openai.com/en/articles/12293630-chatgpt-pulse) is the primary source: snippet says it runs a daily background task based on past chats, memory, and feedback; requires both memory and chat history on; feedback via thumbs and "Give feedback" text, and feedback history is viewable and deletable. The fetch returned 403, so these points are from search text (**snippet**).
- Launch: Pro first, mobile first, at $200/month (snippet). Later rollout unverified.
- Worked: a bounded daily product (cards, not a stream); explicit thumbs feedback; expiry.
- Failed or stated limits: OpenAI said Pulse may show irrelevant information (snippet from coverage).

### 2b. Claude memory and chat search (Anthropic)
- Source: [Claude Help Center article 11817273](https://support.claude.com/en/articles/11817273) (**checked**, page says "updated yesterday" without a date).
- Mechanism: memory is built from chats as individual topics as conversations happen (not a summary written after the fact); "remember this" saves directly; Settings > Memory lets users read, edit, delete topics, pause memory, or reset all. Projects have their own memory, and project chats do not see other projects' memory. Incognito chats are not saved or searched.
- Legacy memory (a few Team and Enterprise orgs) was a 24-hour summary; the article says legacy users can export until 9 Sep 2026.
- Launch timing (snippet): chat search mid-Aug 2025; memory for Team and Enterprise Sep 2025; Pro and Max around 23 Oct 2025 (single third-party source).
- Worked: user-visible, editable, scoped (per project), and off-switch per chat. This is the strongest privacy and control pattern in the set.

### 2c. Google Gemini proactive assistance (2026, beta only)
- Sources: [9to5Google, 27 Apr 2026](https://9to5google.com/2026/04/27/gemini-proactive-assistance/), [Android Authority, 28 Apr 2026](https://androidauthority.com/google-gemini-proactive-assistance-3661314) (snippets).
- Mechanism as reported from beta strings: user chooses which apps feed it (Gmail, Calendar, Contacts, Messages named); suggestions before asking (reminders, suggested email replies). Reported on-device processing; not for training or human review.
- Status: found in Google app 17.18 beta via teardown; not confirmed as launched. Treat all of it as **unverified**.

### 2d. Microsoft Recall (Windows, 2024 onward)
- Sources: coverage snippets from TechTarget and TechRepublic (2024-2025).
- Mechanism: periodic screenshots with local OCR and semantic search.
- Failure modes (snippet): preview versions stored screenshots unencrypted; launch was postponed; relaunched opt-in, with encryption keyed to TPM and Windows Hello, BitLocker required, and filtering that is not fully reliable (card numbers still captured per reports); most private-browsing windows excluded; uninstallable.
- Lesson: always-on capture triggers a backlash regardless of how good the retrieval is.

### 2e. Rewind / Limitless (acquired by Meta)
- Source: [9to5Mac, 5 Dec 2025](https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/) (snippet; TechCrunch coverage same date per snippet).
- Facts (snippet): Meta announced the acquisition 5 Dec 2025; Limitless stopped selling the pendant; Rewind's screen and audio capture was turned off 19 Dec 2025; some regions lost support.
- Lesson: a product built on continuous personal capture was absorbed, and its capture ended. Dependence on a single vendor's capture pipeline is a risk to design around; ky's inputs should be data the user already owns (its own sessions and memory files).

### 2f. Older context-card systems (Google Now, Assistant)
- I did not fetch primary sources for Google Now. From general knowledge: contextual cards keyed to location, time, and calendar. This is **not** verified in this session. Left as an open item.

---

## 3. Research on proactive agents and interruption timing

### 3a. Proactive Agent (Lu et al., ICLR 2025; arXiv 2410.12361)
- Source: [arXiv 2410.12361 v3 HTML](https://arxiv.org/html/2410.12361v3) (**checked**).
- Pipeline (checked): an environment monitor (ActivityWatch-based in the data collection) records keyboard, mouse, visited pages, and dev tools, converted to text. The proactive agent ingests events, updates memory, and predicts a task from history, user traits, and feedback. It outputs a predicted task or nothing; silence is an allowed output.
- Data: ProactiveBench, reported as 233 test events from real users in the search snippet and 1,760 labeled entries (1,640 train, 120 test) in the labeling section (**checked**; the two counts are from different parts of the paper; I did not reconcile them).
- Results (Table 3, **checked**): best model Qwen2-7B-Proactive, Recall 100%, Precision 49.78%, Accuracy 50.66%, False-Alarm 50.22%, F1 66.47%. GPT-4o False-Alarm 51.85%; GPT-4o-mini 64.73%.
- Failure mode, central: false alarms. The paper's own text has small inconsistencies (66.07% vs 66.47%; LLaMA numbers differ between text and table); I used the table.
- Stated limits (**checked**): limited environment settings; relatively high false-alarm ratio; dynamic adjustment of proactiveness needs work; user-centric evaluation needed; privacy concerns need attention.
- Lesson: recall of 100% with precision near 50% is the default failure. Proactivity needs a precision-first threshold.

### 3b. ProactiveBench variants (2025-2026)
- Three different benchmarks share the name: an MLLM proactiveness benchmark (arXiv 2603.19466, 2026), a video-LLM timing benchmark with a PAUC metric (arXiv 2507.09313, Jul 2025), and ProactBench (arXiv 2605.09228). The finding from 2603.19466 is that model capacity does not predict proactive behavior (snippet). Not the same benchmark as 3a; cite by arXiv ID.

### 3c. Mixed-initiative principles (Horvitz, CHI 1999)
- Source: "Principles of Mixed-Initiative User Interfaces," CHI '99 pp. 159-166, [PDF](https://www.erichorvitz.com/chi99horvitz.pdf) and [page](https://erichorvitz.com/uiact.htm). **Not checked**: both fetches returned an unreadable PDF and a page without the text.
- Snippet-level claims (secondary sources): the paper names four problems: poor guessing of user goals, weak weighing of costs and benefits of automated action, poor timing, and too little attention to letting the user steer automated services. One review says 12 principles; I could not retrieve the list. A lecture summary gives the core rule: act autonomously only when expected value exceeds that of inaction for the user.
- Lesson (inferred from the rule): the agent's decision to surface should compare expected value of the surfaced item against the expected cost of the interruption, not against zero.

### 3d. Interruption cost and breakpoints (Horvitz and Iqbal, Bailey)
- Iqbal and Horvitz, "Disruption and Recovery of Computing Tasks," CHI 2007 ([PDF](https://www.erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf)). **Not checked**: the PDF was unreadable in fetch. Claims from snippets only: disruption and recovery measured from logged interactions.
- Iqbal and Bailey (2007) predicted coarse, medium, and fine breakpoints with 69%-87% average accuracy without extra hardware (snippet from a survey); cost measured as resumption lag. Breakpoint-timed notifications reduced disruption in their work (snippet; inferred from the framing).
- A 2024 Frontiers paper uses pupil dilation to find low-workload moments better for interruptions (snippet).

### 3e. Timing of LLM proactive speech (2024-2026)
- Edwards et al. (CUI 2024, arXiv 2405.07528): an adaptive-timing speech agent was rated a poorer partner and less appropriate than a static one (snippet). Lesson: clever timing can backfire if it changes the feel of the agent. Keep the surfacing rhythm predictable.
- NeurIPS 2026 "Human-first pacing" (snippet): proposal to estimate what the user would do if the agent waited. No empirical results seen.
- A blog (secondary, unverified) reports 52% engagement at workflow boundaries vs 62% dismissal for mid-task interruptions in a 15-developer field study. Not verified; do not cite as fact.

### 3f. Speculative and anticipatory retrieval (2026)
- OnePred (arXiv 2605.23668, snippet): predicts the user's next question from dialogue, names pre-fetching documents as a use, reports up to 22x lower per-turn tokens vs full history.
- Predictive Prefetching for RAG (arXiv 2605.17989, snippet): prefetches during generation using token entropy as trigger; reports 43.5% end-to-end latency cut; most wasted prefetches were still used later.
- Neural Paging (arXiv 2603.02228, snippet): predictive prefetch from partial output.
- None is from 2025; all are preprints with self-reported numbers. Use for mechanism, not magnitude.

---

## 4. Design patterns for a single-user personal agent (ky)

Each is tied to a source above. "Source" marks the evidence; "inferred" marks my synthesis.

1. **Precompute the brief, not the answer.** Run the nightly pass to produce a small, ranked artifact (the morning brief and the next-session context), and keep it separate from memory writes. Source: Letta split (1b), sleep-time compute (1a).
2. **Use an importance threshold for reflection.** Trigger a consolidation pass when the summed importance of new events crosses a budget, in addition to the nightly clock. Source: Park et al. threshold of 150 (1c). Inferred: pick the budget from ky's own logs, not from the paper.
3. **Score importance, then store it.** Have the model rate each new memory 1-10 at write time so the nightly pass sorts by importance rather than re-reading everything. Source: 1c.
4. **Make consolidation output cite its evidence.** Every consolidated fact or insight links the session IDs it came from. Source: Park et al. citation pointers (1c); A-MEM note links (1e). Inferred: this is also what makes the user able to audit or retract.
5. **Bi-temporal facts; invalidate, don't delete.** Store valid-from/valid-to and ingestion time. A changed preference closes the old fact. Source: Zep/Graphiti (1f).
6. **Per-scope memory with a visible boundary.** Memory is scoped to a project or automation, and a scope cannot read another's memory unless the user says so. Source: Claude projects (2b).
7. **Let the user edit and forget in one place.** A single screen shows what ky has consolidated, with edit, delete, and pause. Source: Claude Settings > Memory (2b); Pulse feedback history (2a).
8. **Cap the surface.** Show at most a few items per day, and expire unsaved items at the end of the day. Source: Pulse 5-10 cards, expiry (2a). Inferred: pick a lower number for ky (for example 3) until feedback says otherwise.
9. **Silence is a valid output.** The pipeline may return "nothing to surface", and that is the default. Source: Proactive Agent predicts nothing when no task is needed (3a). This is the main answer to the 50% false-alarm result.
10. **Precision before recall for interruptions.** Tune the surfacing threshold for precision: an item that is shown must be likely to be wanted. Source: 3a (100% recall, ~50% precision was the failure). Inferred.
11. **Gate interruptions on task boundaries.** Surface at a natural break (session end, automation completion, a commit) rather than mid-task. Source: breakpoint research (3d). Caveat: 3e shows that a fixed rhythm can beat a clever adaptive one; start with boundaries plus a fixed schedule.
12. **Log every surfaced item with an outcome.** Record shown, acted, dismissed, thumbs up or down. This is the feedback loop for threshold tuning. Source: Pulse thumbs and feedback history (2a); Proactive Agent user-accept labels (3a).
13. **Prefetch only what the next session likely needs, and mark it as a guess.** Build the next-session context from the recent sessions and open tasks; label it as predicted so the agent can ignore it if the user's query differs. Source: OnePred and prefetch preprints (3f), with the caveat that they are preprints. Inferred for ky's use.
14. **Keep capture to data ky already owns.** Use the user's sessions, memory files, and automation outputs as inputs; do not add continuous screen or audio capture. Source: Recall backlash (2d); Rewind shutdown (2e).
15. **Opt-in per input source, default off.** Calendar, mail, or other connectors start off and show what they feed. Source: Pulse connectors off by default (2a, snippet); Gemini app-choice model (2c, unverified).

---

## Open questions and limits

- Horvitz 1999 principle list and the Iqbal and Horvitz 2007 numbers were not retrieved. Pattern 11 relies on secondary descriptions. Next step: read the PDFs with a text extractor, or cite as secondary.
- The Pulse help article and the Letta blog are the primary sources, but the Pulse article returned 403 on fetch; its details are from search text.
- Mem0, Zep, A-MEM, and the prefetch preprints were checked only at the snippet level. Their numbers are self-reported.
- Google Now and Assistant contextual cards were not researched beyond general knowledge.
- Whether Gemini proactive assistance shipped after 28 Apr 2026 was not confirmed.
- No peer-reviewed evaluation of LLM-based interruption timing for a personal agent was found; pattern 11 and the timing numbers are the weakest-evidence part of this file.
- All product facts are as of the search date (2026-10-16) and may have changed.
