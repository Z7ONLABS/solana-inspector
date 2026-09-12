import type {
  SolanaInspectionReport,
  SolanaInspectionTransaction,
} from "../../analytics/solana/inspection-types";

/** Self-contained presentation function, serialized after TypeScript compilation. */
export function mountInspectorReader(doc: Document): void {
  const root = doc.getElementById("inspector-reader");
  const fallback = doc.getElementById("reader-fallback");
  const payload = doc.getElementById("inspection-data");
  if (!root || !fallback || !payload) return;
  function fail() {
    if (root) {
      root.hidden = true;
      root.dataset.state = "failed";
    }
    if (fallback) {
      fallback.hidden = false;
      fallback.setAttribute("role", "alert");
    }
  }
  try {
    const report = JSON.parse(
      payload.textContent || "",
    ) as SolanaInspectionReport;
    if (
      report.version !== "solana-inspection-v2" ||
      !Array.isArray(report.transactions) ||
      report.transactions.length > 1_000 ||
      report.transactions.some((tx, index) => tx.inputIndex !== index)
    )
      throw new Error("Unsupported local report");
    const pageSize = 25;
    const tableSize = 50;
    let page = 0;
    let selectedIndex: number | null = null;
    let savedScrollY = 0;
    function el<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      text?: unknown,
      className?: string,
    ): HTMLElementTagNameMap[K] {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = String(text ?? "Unavailable");
      if (className) node.className = className;
      return node;
    }
    function safe(action: () => void) {
      return () => {
        try {
          action();
        } catch {
          fail();
        }
      };
    }
    function button(label: string, action: () => void, className?: string) {
      const node = el("button", label, className);
      node.type = "button";
      node.addEventListener("click", safe(action));
      return node;
    }
    function heading(text: string, level: 2 | 3 = 3) {
      const node = el(level === 2 ? "h2" : "h3", text);
      node.tabIndex = -1;
      return node;
    }
    function focus(node: HTMLElement) {
      node.focus({ preventScroll: true });
    }
    function lazy(label: string, build: (host: HTMLElement) => void) {
      const details = el("details");
      details.append(el("summary", label));
      let rendered = false;
      details.addEventListener(
        "toggle",
        safe(() => {
          if (details.open && !rendered) {
            const content = el("div", undefined, "detail-content");
            build(content);
            details.append(content);
            rendered = true;
          }
        }),
      );
      return details;
    }
    /** Exact evidence tree; nodes are expanded explicitly, arrays/objects paged. */
    function valueTree(value: unknown): HTMLElement {
      if (value === null || typeof value !== "object")
        return el(
          "pre",
          value === undefined ? "Unavailable" : JSON.stringify(value),
          "exact-value",
        );
      const holder = el("div", undefined, "evidence-tree");
      const keys = Object.keys(value);
      let treePage = 0;
      const entries = el("div");
      const controls = el("nav", undefined, "pager");
      controls.setAttribute("aria-label", "Evidence entries");
      const status = el("span");
      status.tabIndex = -1;
      status.setAttribute("aria-live", "polite");
      const previous = button("Previous entries", () => {
        treePage--;
        draw();
        focus(status);
      });
      const next = button("Next entries", () => {
        treePage++;
        draw();
        focus(status);
      });
      controls.append(previous, status, next);
      function draw() {
        entries.replaceChildren();
        for (const key of keys.slice(
          treePage * tableSize,
          (treePage + 1) * tableSize,
        )) {
          const child = (value as Record<string, unknown>)[key];
          if (child !== null && typeof child === "object")
            entries.append(
              lazy(
                `${key} · ${Array.isArray(child) ? `${child.length} entries` : "object"}`,
                (node) => node.append(valueTree(child)),
              ),
            );
          else {
            const entry = el("div", undefined, "evidence-value");
            entry.append(el("strong", key), valueTree(child));
            entries.append(entry);
          }
        }
        previous.disabled = treePage === 0;
        next.disabled = (treePage + 1) * tableSize >= keys.length;
        status.textContent = keys.length
          ? `Entries ${treePage * tableSize + 1}–${Math.min((treePage + 1) * tableSize, keys.length)} of ${keys.length}`
          : "No entries";
      }
      draw();
      holder.append(entries);
      if (keys.length > tableSize) holder.append(controls);
      return holder;
    }
    function table<T>(
      label: string,
      headers: string[],
      rows: readonly T[],
      values: (row: T) => unknown[],
    ) {
      const holder = el("div", undefined, "table-section");
      if (!rows.length) {
        holder.append(
          el("p", "No records in this section. This is not proof of absence."),
        );
        return holder;
      }
      const grid = el("table");
      const head = el("thead");
      const headRow = el("tr");
      for (const name of headers) {
        const th = el("th", name);
        th.scope = "col";
        headRow.append(th);
      }
      head.append(headRow);
      const body = el("tbody");
      grid.append(el("caption", label, "sr-only"), head, body);
      let tablePage = 0;
      const controls = el("nav", undefined, "pager");
      controls.setAttribute("aria-label", `${label} pages`);
      const status = el("span");
      status.tabIndex = -1;
      status.setAttribute("aria-live", "polite");
      const previous = button("Previous rows", () => {
        tablePage--;
        draw();
        focus(status);
      });
      const next = button("Next rows", () => {
        tablePage++;
        draw();
        focus(status);
      });
      controls.append(previous, status, next);
      function draw() {
        body.replaceChildren();
        for (const row of rows.slice(
          tablePage * tableSize,
          (tablePage + 1) * tableSize,
        )) {
          const tr = el("tr");
          values(row).forEach((value, index) => {
            const cell = el("td");
            cell.dataset.label = headers[index];
            if (value && typeof value === "object" && "nodeType" in value)
              cell.append(value as Node);
            else cell.textContent = String(value ?? "Unavailable");
            tr.append(cell);
          });
          body.append(tr);
        }
        previous.disabled = tablePage === 0;
        next.disabled = (tablePage + 1) * tableSize >= rows.length;
        status.textContent = `Rows ${tablePage * tableSize + 1}–${Math.min((tablePage + 1) * tableSize, rows.length)} of ${rows.length}`;
      }
      draw();
      holder.append(grid);
      if (rows.length > tableSize) holder.append(controls);
      return holder;
    }
    const exclusionLabels: Record<string, string> = {
      exact_duplicate_observation: "Exact duplicate observation",
      conflicting_transaction_revision:
        "Conflicting revisions of the supplied signature",
      transaction_identity_unavailable:
        "Supplied transaction identity unavailable",
    };
    const economicallyLimited = (tx: SolanaInspectionTransaction) =>
      tx.economic.blockers.some((code) => code !== "finality_unavailable");
    // Include references without balance metadata; never lowercase addresses.
    const searchable = report.transactions.map((tx) => {
      const accounts = new Set<string>();
      for (const account of tx.normalized.accounts)
        accounts.add(account.address);
      for (const account of tx.normalized.tokenAccounts) {
        accounts.add(account.accountAddress);
        if (account.preOwner) accounts.add(account.preOwner);
        if (account.postOwner) accounts.add(account.postOwner);
      }
      for (const instruction of tx.normalized.instructions) {
        for (const account of instruction.accountAddresses || [])
          accounts.add(account);
        const pending: unknown[] = [instruction.info];
        while (pending.length) {
          const value = pending.pop();
          if (
            typeof value === "string" &&
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
          )
            accounts.add(value);
          else if (value && typeof value === "object") {
            // A wide user-supplied object must not become a variadic call that
            // exceeds the browser's argument-count ceiling.
            for (const child of Object.values(value)) pending.push(child);
          }
        }
      }
      for (const movement of tx.economic.rawMovements) {
        accounts.add(movement.fromAccount);
        accounts.add(movement.toAccount);
      }
      for (const lifecycle of tx.economic.lifecycle) {
        accounts.add(lifecycle.accountAddress);
        for (const account of lifecycle.relatedAccounts || [])
          accounts.add(account);
        if (lifecycle.authority) accounts.add(lifecycle.authority);
      }
      return [tx.economic.signature || "", ...accounts];
    });
    const list = el("section");
    list.id = "observation-list";
    const listHeading = heading("Inspect the observations.", 2);
    list.append(
      listHeading,
      el(
        "p",
        "Shown in supplied input order, not verified blockchain order. Filters change this list only; the sample totals above remain unchanged.",
      ),
    );
    const filters = el("div", undefined, "reader-filters");
    const searchLabel = el(
      "label",
      "Search signature or account (case-sensitive)",
    );
    const search = el("input");
    search.id = "observation-search";
    search.type = "search";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("autocapitalize", "none");
    searchLabel.htmlFor = search.id;
    const filterLabel = el("label", "Observation filter");
    const filter = el("select");
    filter.id = "observation-filter";
    filterLabel.htmlFor = filter.id;
    for (const [value, label] of [
      ["all", "All observations"],
      ["economic", "With economic limitations"],
      ["excluded", "Excluded from economic totals"],
    ]) {
      const option = el("option", label);
      option.value = value;
      filter.append(option);
    }
    const searchGroup = el("div");
    searchGroup.append(searchLabel, search);
    const filterGroup = el("div");
    filterGroup.append(filterLabel, filter);
    filters.append(searchGroup, filterGroup);
    const resultStatus = el("p", undefined, "list-status");
    resultStatus.id = "observation-status";
    resultStatus.tabIndex = -1;
    resultStatus.setAttribute("role", "status");
    const rows = el("ol", undefined, "observation-rows");
    const pager = el("nav", undefined, "pager");
    pager.setAttribute("aria-label", "Observation pages");
    const pageStatus = el("span");
    pageStatus.tabIndex = -1;
    const previous = button("Previous observations", () => {
      page--;
      drawList();
      focus(resultStatus);
    });
    previous.id = "observations-previous";
    const next = button("Next observations", () => {
      page++;
      drawList();
      focus(resultStatus);
    });
    next.id = "observations-next";
    pager.append(previous, pageStatus, next);
    list.append(filters, resultStatus, rows, pager);
    const detail = el("section");
    detail.id = "observation-detail";
    detail.hidden = true;
    function filtered() {
      const query = search.value.trim();
      return report.transactions.filter(
        (tx) =>
          (filter.value !== "economic" || economicallyLimited(tx)) &&
          (filter.value !== "excluded" ||
            !tx.inclusion.includedInEconomicTotals) &&
          (!query ||
            searchable[tx.inputIndex].some((value) => value.includes(query))),
      );
    }
    function drawList() {
      const matches = filtered();
      page = Math.max(
        0,
        Math.min(page, Math.ceil(matches.length / pageSize) - 1),
      );
      rows.replaceChildren();
      rows.start = page * pageSize + 1;
      const visible = matches.slice(page * pageSize, (page + 1) * pageSize);
      for (const tx of visible) {
        const row = el("li");
        row.dataset.inputIndex = String(tx.inputIndex);
        const open = button(
          `Observation ${tx.inputIndex + 1}`,
          () => openObservation(tx.inputIndex),
          "observation-open",
        );
        open.dataset.openObservation = String(tx.inputIndex);
        open.setAttribute(
          "aria-label",
          `Open observation ${tx.inputIndex + 1}`,
        );
        const identity = el("div");
        identity.append(
          open,
          el("p", tx.economic.signature || "Signature unavailable", "address"),
        );
        const state = el("div", undefined, "observation-state");
        state.append(
          el("span", tx.economic.economicClassification),
          el(
            "span",
            tx.inclusion.includedInEconomicTotals
              ? "Included in totals"
              : "Excluded from totals",
          ),
          el(
            "span",
            economicallyLimited(tx)
              ? "Economic limitations"
              : "No local economic blockers",
          ),
        );
        row.append(identity, state);
        rows.append(row);
      }
      resultStatus.textContent = matches.length
        ? `${matches.length} of ${report.transactions.length} observations match. Showing ${page * pageSize + 1}–${page * pageSize + visible.length}.`
        : `No matching observations. The sample still contains ${report.transactions.length} observations.`;
      previous.disabled = page === 0;
      next.disabled = (page + 1) * pageSize >= matches.length;
      pageStatus.textContent = `Page ${page + 1} of ${Math.max(1, Math.ceil(matches.length / pageSize))}`;
    }
    function showList() {
      detail.hidden = true;
      detail.replaceChildren();
      list.hidden = false;
      const open = rows.querySelector<HTMLButtonElement>(
        `button[data-open-observation="${selectedIndex}"]`,
      );
      focus(open || listHeading);
      doc.defaultView?.scrollTo({ top: savedScrollY, behavior: "instant" });
    }
    function openObservation(inputIndex: number) {
      const tx = report.transactions[inputIndex];
      if (!tx || tx.inputIndex !== inputIndex)
        throw new Error("Observation unavailable");
      selectedIndex = inputIndex;
      savedScrollY = doc.defaultView?.scrollY || 0;
      detail.replaceChildren();
      const economic = tx.economic;
      const title = heading(`Observation ${inputIndex + 1}`, 2);
      detail.append(
        button("Back to observations", showList),
        title,
        el("p", economic.signature || "Signature unavailable", "address"),
      );
      detail.append(
        el(
          "p",
          tx.inclusion.includedInEconomicTotals
            ? "Eligible for economic totals — not a confirmation of execution, reconciliation or financial validity."
            : "Excluded from economic totals. Its evidence remains visible below.",
          "notice",
        ),
      );
      detail.append(
        el(
          "p",
          tx.identityFirstInputIndex === null
            ? "Unavailable — not counted as an identified transaction."
            : tx.inclusion.countedInIdentifiedTransactions
              ? "Counted once among distinct supplied signatures; not signature validation."
              : `Already represented by observation ${tx.identityFirstInputIndex + 1}; not counted as another identity.`,
        ),
      );
      if (tx.inclusion.exclusionReasons.length)
        detail.append(
          el(
            "p",
            `Exclusion reasons: ${tx.inclusion.exclusionReasons.map((code) => exclusionLabels[code] || code).join("; ")}. Exclusion does not resolve the underlying evidence.`,
            "notice",
          ),
        );
      if (tx.duplicateOfInputIndex !== null)
        detail.append(
          el(
            "p",
            `Duplicate of observation ${tx.duplicateOfInputIndex + 1} — excluded from summary economic totals. Repeated evidence remains available.`,
            "notice",
          ),
        );
      detail.append(
        el(
          "p",
          `Classification: ${economic.economicClassification} · Interpretation: ${economic.state} · Transaction success: ${economic.succeeded ?? "Unavailable"}`,
        ),
      );
      detail.append(
        el(
          "p",
          `Supplied slot: ${tx.normalized.slot ?? "Unavailable"} · Transaction index: ${tx.normalized.transactionIndex ?? "Unavailable"} · Time: ${tx.normalized.blockTime ?? "Unavailable"}`,
          "technical",
        ),
      );
      const jump = el("nav", undefined, "section-links");
      jump.setAttribute("aria-label", "Observation sections");
      for (const [id, label] of [
        ["movement-evidence", "Movements"],
        ["fee-evidence", "Fees"],
        ["balance-evidence", "Balances"],
        ["limitation-evidence", "Limitations"],
        ["instruction-evidence", "Instructions"],
      ]) {
        const target = el("a", label);
        target.href = `#${id}`;
        jump.append(target);
      }
      detail.append(jump);
      const movementsHeading = heading("Observed movements");
      movementsHeading.id = "movement-evidence";
      const selectedInstruction = el("section");
      selectedInstruction.id = "selected-instruction";
      selectedInstruction.hidden = true;
      selectedInstruction.setAttribute(
        "aria-labelledby",
        "selected-instruction-title",
      );
      function instructionReference(
        outerIndex: number,
        innerIndex: number | null,
      ) {
        const matches = tx.normalized.instructions.filter(
          (instruction) =>
            instruction.outerIndex === outerIndex &&
            instruction.innerIndex === innerIndex,
        );
        const location =
          matches.length === 1
            ? matches[0].path
            : innerIndex === null
              ? String(outerIndex)
              : `${outerIndex}.${innerIndex}`;
        const link = el("a", location, "instruction-reference");
        link.href = "#selected-instruction";
        link.setAttribute(
          "aria-label",
          `View original instruction ${location}`,
        );
        link.addEventListener("click", (event) => {
          event.preventDefault();
          safe(() => {
            const scrollY = doc.defaultView?.scrollY || 0;
            const title = heading(`Original instruction ${location}`);
            title.id = "selected-instruction-title";
            selectedInstruction.replaceChildren(title);
            if (matches.length === 1)
              selectedInstruction.append(valueTree(matches[0]));
            else {
              selectedInstruction.append(
                el(
                  "p",
                  matches.length
                    ? "Multiple retained instructions share this position. No revision is selected as authoritative."
                    : "The retained normalized instructions do not contain this position. Its source cannot be resolved from this report.",
                  "notice",
                ),
              );
              if (matches.length)
                selectedInstruction.append(valueTree(matches));
            }
            selectedInstruction.append(
              button("Back to movement reference", () => {
                selectedInstruction.hidden = true;
                selectedInstruction.replaceChildren();
                focus(link.isConnected ? link : movementsHeading);
                doc.defaultView?.scrollTo({
                  top: scrollY,
                  behavior: "instant",
                });
              }),
            );
            selectedInstruction.hidden = false;
            focus(title);
            title.scrollIntoView({ block: "start", behavior: "instant" });
          })();
        });
        return link;
      }
      detail.append(
        movementsHeading,
        table(
          "Observed movements",
          [
            "Asset",
            "Exact amount",
            "From account",
            "To account",
            "Treatment",
            "Instruction",
          ],
          economic.rawMovements,
          (m) => [
            m.asset.symbol || m.asset.assetId,
            m.amount,
            m.fromAccount,
            m.toAccount,
            m.classification,
            instructionReference(m.outerIndex, m.innerIndex),
          ],
        ),
        selectedInstruction,
        el(
          "p",
          "Instruction references use zero-based outer.inner positions; an outer instruction has no dot. Open a reference to inspect its exact retained evidence.",
          "technical",
        ),
      );
      detail.append(
        lazy("Indicated, debited and credited quantities (raw units)", (host) =>
          host.append(
            table(
              "Raw movement quantities",
              [
                "Asset",
                "Instruction",
                "Indicated raw",
                "Debit raw",
                "Credit raw",
                "Unexplained difference raw",
                "Evidence",
              ],
              economic.rawMovements,
              (m) => [
                m.asset.assetId,
                instructionReference(m.outerIndex, m.innerIndex),
                m.quantityEvidence?.grossRaw ?? m.rawAmount,
                m.quantityEvidence?.debitRaw,
                m.quantityEvidence?.creditRaw,
                m.quantityEvidence?.unexplainedDifferenceRaw,
                m.quantityEvidence?.state ??
                  "Per-movement endpoint evidence unavailable — inspect account balances",
              ],
            ),
          ),
        ),
      );
      detail.append(
        lazy("Observed token accounts and owners", (host) =>
          host.append(
            table(
              "Observed token accounts and owners",
              [
                "Account",
                "Mint",
                "Owner before",
                "Owner after",
                "Raw before",
                "Raw after",
              ],
              tx.normalized.tokenAccounts,
              (a) => [
                a.accountAddress,
                a.mint,
                a.preOwner,
                a.postOwner,
                a.preRaw,
                a.postRaw,
              ],
            ),
          ),
        ),
      );
      const feesHeading = heading("Fees and payer");
      feesHeading.id = "fee-evidence";
      detail.append(
        feesHeading,
        table(
          "Fees and payer",
          [
            "Kind",
            "Asset",
            "Exact amount",
            "Exact raw amount",
            "Payer",
            "Charged to this wallet",
          ],
          economic.fees,
          (f) => [
            f.kind,
            f.asset.symbol || f.asset.assetId,
            f.amount,
            f.rawAmount,
            f.payerWallet,
            f.chargedToAnalyzedWallet ? "Yes" : "No",
          ],
        ),
      );
      detail.append(
        el(
          "p",
          `Fee interpretation complete: ${economic.feesComplete ? "Yes, within the supplied interpretation" : "No"}. Sponsored fees are not charged to this wallet.`,
        ),
      );
      const balancesHeading = heading("Touched-account balance observations");
      balancesHeading.id = "balance-evidence";
      detail.append(
        balancesHeading,
        table(
          "Touched-account balances",
          [
            "Asset",
            "Raw before",
            "Raw after",
            "Raw delta",
            "Expected delta from recognized movements",
            "Unexplained raw difference",
            "Touched accounts complete",
          ],
          economic.balanceEvidence,
          (b) => [
            b.asset.symbol || b.asset.assetId,
            b.preRaw,
            b.postRaw,
            b.deltaRaw,
            b.movementCheck?.expectedDeltaRaw,
            b.movementCheck?.unexplainedDifferenceRaw,
            b.complete ? "Yes — not the whole wallet" : "No",
          ],
        ),
      );
      detail.append(
        el(
          "p",
          "Expected delta uses recognized movements and the network fee actually paid by this wallet. A residual is not automatically a fee or an inferred transfer. Zero residual does not establish complete instruction support.",
        ),
      );
      detail.append(
        lazy("Per-account balances and ownership evidence", (host) =>
          host.append(valueTree(economic.balanceEvidence)),
        ),
      );
      const limitationsHeading = heading("Limitations and checks");
      limitationsHeading.id = "limitation-evidence";
      detail.append(
        limitationsHeading,
        table(
          "Required evidence",
          ["Code", "Evidence needed"],
          tx.requirements,
          (r) => [r.code, r.neededEvidence],
        ),
      );
      detail.append(
        lazy("Input limitations, economic blockers and scoped checks", (host) =>
          host.append(
            valueTree({
              inputLimitations: tx.limitations,
              economicBlockers: economic.blockers,
              scopedBlockers: economic.blockerEvidence,
            }),
          ),
        ),
      );
      // Signature-grouped sample checks must not be attributed to a conflicting revision.
      if (tx.inclusion.includedInEconomicTotals && economic.signature)
        detail.append(
          lazy("Sample quantity checks for this included signature", (host) =>
            host.append(
              valueTree(
                report.sample.quantityReconciliation.filter(
                  (item) => item.signature === economic.signature,
                ),
              ),
            ),
          ),
        );
      else
        detail.append(
          el(
            "p",
            "Sample quantity reconciliation is not attributed to this excluded revision. Its original per-observation evidence remains available.",
          ),
        );
      const instructionsHeading = heading(
        "Instructions, authorities and lifecycle",
      );
      instructionsHeading.id = "instruction-evidence";
      detail.append(
        instructionsHeading,
        lazy("Original normalized instructions and references", (host) =>
          host.append(
            table(
              "Normalized instructions",
              ["Instruction", "Program", "Type", "Exact retained evidence"],
              tx.normalized.instructions,
              (ix) => [
                ix.path,
                ix.program || ix.programId,
                ix.type,
                lazy(`Inspect instruction ${ix.path}`, (node) =>
                  node.append(valueTree(ix)),
                ),
              ],
            ),
          ),
        ),
      );
      detail.append(
        lazy("Account lifecycle and authority observations", (host) =>
          host.append(valueTree(economic.lifecycle)),
        ),
      );
      detail.append(
        lazy(
          "Complete observation: exact fields and original references",
          (host) => host.append(valueTree(tx)),
        ),
      );
      detail.append(button("Back to observations", showList));
      list.hidden = true;
      detail.hidden = false;
      focus(title);
      title.scrollIntoView({ block: "start", behavior: "instant" });
    }
    search.addEventListener(
      "input",
      safe(() => {
        page = 0;
        drawList();
      }),
    );
    filter.addEventListener(
      "change",
      safe(() => {
        page = 0;
        drawList();
      }),
    );
    const continuity = el("section");
    continuity.id = "account-continuity";
    continuity.append(
      heading("Observed-account continuity", 2),
      el(
        "p",
        `Sample state: ${report.sample.state}. Order basis: ${report.sample.orderBasis}. Observed accounts are not proof of complete wallet inventory or chain history.`,
      ),
    );
    continuity.append(
      lazy("Observed account intervals", (host) =>
        host.append(
          table(
            "Observed account intervals",
            [
              "Account",
              "Asset",
              "Owner",
              "Generation / ownership interval",
              "Exact raw amount",
              "Closed / ended",
              "Supplied slot",
            ],
            report.sample.accountInventory,
            (a) => [
              a.address,
              a.asset.symbol || a.asset.assetId,
              a.owner,
              `${a.generation} / ${a.ownershipInterval}`,
              a.rawAmount,
              `${a.closed} / ${a.ended}`,
              a.slot,
            ],
          ),
        ),
      ),
    );
    continuity.append(
      lazy("Sample reasons and unresolved issues", (host) =>
        host.append(
          valueTree({
            reasons: report.sample.reasons,
            issues: report.sample.issues,
          }),
        ),
      ),
    );
    continuity.append(
      lazy("Complete sample continuity evidence", (host) =>
        host.append(valueTree(report.sample)),
      ),
    );
    root.replaceChildren(list, detail, continuity);
    drawList();
    fallback.hidden = true;
    root.hidden = false;
    root.dataset.state = "ready";
  } catch {
    fail();
  }
}
