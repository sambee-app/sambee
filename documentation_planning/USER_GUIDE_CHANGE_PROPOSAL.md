# User Guide Change Proposal

## Status and Purpose

Status: Proposal for implementation review. This document does not change the published user guide.

The user guide must help new users understand what Sambee can do for them, then help them complete useful file tasks. It must also contain one clear definition page that search engines and AI systems can identify and quote.

This plan combines the proposed guide reorganization, the benefit-led introduction, the canonical product definition, and the related page improvements.

The version scope still needs a decision. The proposals are not permission to change every documentation version or to change application behavior.

## Goals

- Explain what Sambee is in a short, accurate, standalone definition.
- Preserve the current structure of What Is Sambee? Improve its wording and accuracy within the existing sections.
- Show concrete benefits before detailed controls and technical explanations.
- Help a new user open and use a file without first learning account administration or installing Companion.
- Make everyday tasks easy to find by their names.
- Omit obvious instructions and unnecessary detail. Explain only user value, relevant Sambee concepts, non-obvious behavior, task limits, and recovery actions.
- Keep desktop enhancements optional and explain their requirements.
- Preserve warnings that prevent data loss, incomplete transfers, and incorrect assumptions about access.
- Use version inheritance to avoid unnecessary copies of documentation.

## Brevity Rules

The [Docs Style Guide](../website/content/docs/0.7/website-dev-guide/authoring-and-tooling/docs-style-guide/index.md#user-guide-value-without-unnecessary-detail) is the source for these rules. The docs-update skill requires authors and AI agents to read and apply it. The rules are accepted authoring requirements; the guide reorganization below remains a proposal.

Keep content only when it explains a concrete benefit or relevant Sambee concept, a non-obvious action or behavior, a task limit or requirement, or an actionable recovery step. Remove content that meets none of these tests, rather than move it to Reference.

Do not explain familiar browsing, standard viewer controls, text entry, or clearly labeled buttons unless Sambee behaves differently. Prefer short task notes over numbered tutorials. Use steps only where a non-obvious workflow requires a specific order.

Keep related short topics on one page with clear headings. A missing page is not automatically a documentation gap; add a page only when distinct user value or non-obvious behavior justifies it. Link to in-app help and existing procedures instead of repeating control and shortcut lists.

Keep important warnings at the relevant action, explain each once, and link to shared recovery guidance. This planning document can be detailed; the resulting user guide must be concise.

## Scope

The proposed changes cover the user guide landing page, its section order, page placement, task instructions, and links to related guides. They include moving administrator-only explanations out of user task pages where suitable documentation exists or needs a coordinated update.

They do not include a new marketing website, application changes, new product capabilities, or a general rewrite of the Admin Guide. Search metadata or template changes are follow-up work only if an inspection identifies a specific problem.

Do not add screenshots to the docs. Use concrete examples and task links to demonstrate the benefits.

## Current Problems

| Problem | Evidence | Proposed Response |
|---|---|---|
| Account management is the second Getting Started page. | [Current navigation](../website/data/docs-nav/2.0.toml) lists the overview, then account management. | Use the second position for What Can You Do With Sambee? Move account management later. |
| Practical outcomes need more emphasis alongside the overview. | [What Is Sambee?](../website/content/docs/1.0/user-guide/getting-started/what-is-sambee/index.md) has a sound structure and describes viewers, editors, and desktop integration. | Improve the existing page without restructuring it. Add a separate benefits page with task links. |
| Connection setup comes before using a connection. | [Connect to an SMB Share](../website/content/docs/0.7/user-guide/accessing-files/connect-to-an-smb-share/index.md) starts with settings and adding a connection. | Explain how to open an available connection first. Keep adding a connection as a separate procedure. |
| Basic tasks are grouped under feature names. | Selection is in [Smart Navigation and the Quick Bar](../website/content/docs/2.0/user-guide/browsing-and-navigation/smart-navigation-and-the-quick-bar/index.md). Copy, move, and extraction are in [Dual-Pane Mode](../website/content/docs/2.0/user-guide/browsing-and-navigation/dual-pane-mode/index.md). | Give these tasks explicit navigation entries or clear task headings in suitable pages. |
| File transfers are grouped with viewing and editing. | [Download and Upload Files](../website/content/docs/1.0/user-guide/viewing-and-editing-files/download-and-upload-files/index.md) is in Viewing & Editing Files. | Move it to Organize and Transfer Files. |
| User instructions contain detailed operational explanations. | The Quick Bar page covers history ranking, retention policy, administrator settings, and many recovery cases. | Keep task limits and recovery actions. Remove unnecessary algorithm details and move administrator policy to the Admin Guide. |
| Text editing is not easy to find as a task. | The overview describes text editing, but the navigation has a Markdown page and text-format reference rather than a named text-editing topic. | Add a short text-editing topic; create a page only if non-obvious behavior justifies it. |
| Some preview details precede useful user information. | [View Images & Read Documents](../website/content/docs/0.7/user-guide/viewing-and-editing-files/view-images-and-read-documents/index.md) explains image processing before viewer controls. | Remove internal processing detail unless it explains a task-relevant difference. Do not replace it with a tutorial on standard controls. |

## Proposed Guide Structure

Use the following section order. Page titles below are proposed editorial titles, not final URL instructions.

| Order | Section | Proposed Pages or Topics |
|---|---|---|
| 1 | Getting Started | What Is Sambee?; What Can You Do With Sambee? |
| 2 | Find and Browse Files | Open Connections and Browse Folders; Select Files and Folders; Find Files and Return to Recent Locations; Mobile Navigation; Dual-Pane Mode; Keyboard Navigation and Shortcuts |
| 3 | Organize and Transfer Files | Copy and Move Files; Download and Upload Files; Work with ZIP Archives; Share Files and Links |
| 4 | View and Edit Files | View Images and Read Documents; View and Edit Text Files; Edit Markdown; File Locking and Conflict Resolution; Recover Unsaved Edits |
| 5 | Use Local Drives and Desktop Apps | Install and Pair the Companion App; Access Local Drives; Edit Files in Desktop Apps; Desktop App Picker |
| 6 | Account and Preferences | Manage Your Account; relevant file browser preferences, kept together rather than split into many small pages |
| 7 | Troubleshooting | Common User Problems, grouped by the task that cannot be completed |
| 8 | Reference | Supported File Formats; Text File Support and Syntax Highlighting; detailed shortcut information if it needs a separate reference |

### Structural Decisions

- Preserve the current section structure of What Is Sambee? Add What Can You Do With Sambee? as the second Getting Started page, not as a replacement definition or a generic walkthrough.
- Remove the separate Accessing Files section. Opening SMB connections belongs with browsing. Local-drive setup belongs with the optional desktop features.
- Rename Browsing and Navigation to Find and Browse Files.
- Add Organize and Transfer Files so readers can find operations without knowing about dual-pane mode.
- Rename Viewing & Editing Files to View and Edit Files.
- Replace the Companion App section with Use Local Drives and Desktop Apps. Explain the benefit in the section title and the dependency in the content.
- Move Manage Your Account to Account and Preferences. It remains user documentation, not administrator documentation.
- Keep Troubleshooting before Reference and link to it from failure points in task pages.
- Keep one procedure for each task. Related pages link to it rather than repeat it.

The page list is a content map, not a requirement to create a separate page for every topic. Selection can be a clear subsection of browsing, text editing can be a short subsection of browser editing, and app selection can be part of desktop editing. Keep separate pages only where distinct user value or non-obvious behavior justifies them. Task headings and links must remain easy to find.

## Canonical Definition Page

### Role and Identity

Keep What Is Sambee? as the first page in Getting Started, with its current title, section order, and heading hierarchy. Improve the definition, wording, and accuracy within the existing sections; do not replace the page with a new outline.

This page is the editorial source for the product definition and capability overview. The second page, What Can You Do With Sambee?, explains practical outcomes and links to tasks. It is not a second definition or a duplicate feature catalog. The guide landing page links to both without repeating their content.

Use confident, benefit-led marketing language on these two pages. Keep useful comparisons and make clear promises about what Sambee helps users do. Retain the current statement: **Sambee can replace traditional tools like Windows File Explorer.** This gives human readers a familiar product category; do not remove it or surround it with a list of caveats. It does not require a claim of complete feature parity. State task-critical requirements where they help the reader, without weakening every benefit with defensive wording.

Editorial canonical status is not an instruction to change HTML canonical URLs. Published version URLs and their metadata must continue to follow the website's version-aware rules.

### Proposed Opening Copy

> Sambee is a self-hosted, browser-based file manager for files on SMB network shares and local drives. It lets users browse files, view images and PDFs, and edit text and Markdown in their browser. With optional Sambee Companion, you can access local drives and open network files in your installed desktop apps, then upload your changes back to the original share without managing downloaded copies or choosing an upload destination.

This is draft copy for versions that support all listed capabilities. Check the capability history before applying it to an older version.

The opening must stand on its own. It names the product, the product category, the storage it uses, the main browser tasks, and the role of Companion. Place the improved copy in the current opening section; no new section is required.

Emphasize the complete desktop-editing workflow: open a network file in an installed app and return changes to the original share through Companion. Keep this distinctive benefit in the opening, not only in the task instructions. Keep the exact Done Editing procedure in the desktop-editing instructions; do not imply automatic synchronization.

### Improvements Within the Existing Structure

| Existing Section | Keep | Improve |
|---|---|---|
| Sambee Turns Your Storage Into a Modern Workspace | The opening section and its position. | Make the opening a short, accurate definition suitable for quotation. |
| Browser-Based File Manager | The File Explorer replacement comparison and the device and storage subsections. | Use the familiar comparison confidently. Clarify browser capabilities and Companion requirements, and simplify server explanations without changing the structure. |
| View and Edit Files | The image/PDF, Markdown/text, and desktop integration subsections. | Improve capability wording and accuracy. State the explicit desktop-edit upload requirement without adding a full procedure. |
| Free & Open Source | The licensing and self-hosting section. | Keep it brief and accurate; link to deployment guidance rather than expand it. |

These section names describe the current 1.0 source inherited by later versions. Preserve the applicable version's existing structure when improving older content. Add a short link to the benefits page without creating a new introduction section.

### Search and AI Readability

- Use the stable title What Is Sambee? and an explicit opening sentence beginning with Sambee is.
- Use consistent terms such as self-hosted file manager, browser-based file manager, SMB network shares, and Sambee Companion where they fit naturally.
- Use meaningful headings and short, self-contained paragraphs that can be understood outside the page.
- Put the definition in ordinary page text, not only in an image, tooltip, or interactive element.
- Link from the user guide landing page to this definition page.
- Keep the File Explorer replacement comparison because it helps human readers understand Sambee. Use confident product promises grounded in its capabilities; avoid keyword repetition and empty superlatives.
- Do not promise that search engines will rank the page or that AI systems will quote it.

During implementation, verify the generated page title, description if supported, indexability, and version-aware canonical behavior. Use the existing website mechanisms. Do not introduce structured data or template changes without a verified need.

## Benefits Page

### What Can You Do With Sambee?

Make this the second Getting Started page. It answers How is Sambee useful to me? while What Is Sambee? remains the definition and capability overview.

Use the [homepage content](../website/data/homepage.yaml) as the starting point, especially its existing-storage promise, rich previews, archive browsing, rendered Markdown table editing, fast directory navigation, and desktop-app integration. Translate these into concrete situations, not a second feature catalog.

### Proposed Opening

> Keep your files where they are and do more with them. Browse design files from your phone, look inside a ZIP without unpacking it, change a Markdown table without editing its markup, or open a network file in your favorite desktop app. Sambee brings these workflows to the storage you already use.

This is draft copy, not a second product definition. Keep the promise direct and select examples supported by the target documentation version.

### Distinctive Outcomes

Use short sections with an outcome-focused heading, a concrete example, and a task link. The homepage source column below is for authors; do not publish the source identifiers as user-facing text.

| Proposed Heading | Concrete Situation and Benefit | Homepage Source | Task Links |
|---|---|---|---|
| Give your existing storage a modern workspace | Keep project files on the NAS or Windows file server you already use and access them through Sambee. No migration to a new cloud library or separate synchronized file collection is required. With Companion, bring local drives into the same workspace and copy files between drives and shares. | Hero; `problem_value.value1`; Access; File management. | SMB connections, local drives, and copy/move guidance. |
| Preview design files from your phone | Check a Photoshop design or a HEIC photo stored on a network share without installing its desktop application or downloading it first. Swipe through a large image collection, including formats a browser cannot normally display on its own. | Rich previews; Fast swiping through images; Professional graphics and modern image formats. | Image viewing, supported formats, and mobile guidance. |
| Look inside a ZIP without unpacking it | Open a ZIP as a virtual folder, browse its directories, and view a file inside it directly. Find the document or image you need without extracting the whole archive; extract or download selected contents when useful. | File management: Inspect, create, and extract ZIP archives. | Work with ZIP Archives and selected-member download/extraction guidance. |
| Change Markdown tables without fighting the markup | Update a project checklist or comparison table directly in its rendered table view instead of aligning pipes and rows in source text. Keep the document as a Markdown file in its existing storage. | Markdown: WYSIWYG table editing. | Markdown editing guidance. |
| Stop digging through folder trees | Type part of a directory name and jump to the matching folder instead of clicking through a deep hierarchy. Return to frequently used locations and use two panes when comparing folders or transferring files. | Instant navigation to any directory; Better file handling; Single-pane and dual-pane layouts. | Smart navigation, recent locations, dual-pane mode, and copy/move guidance. |
| Edit in your desktop apps. Return changes to the original share. | Work on network files in Word, Photoshop, LibreOffice, or another installed app. Sambee Companion handles the file handoff and uploads your finished edits back to their source, so you do not have to manage a separate download-and-upload workflow. | Native editing; Edit in desktop apps; Save back to source location. | Companion setup and desktop editing, including Done Editing upload. |

Lead with the existing-storage promise, then the browser-only examples, and finish with the optional desktop workflow. Read-only users must see useful outcomes in previews, archive inspection, and navigation. Mention Companion only where it is required.

Do not dilute these examples with generic claims such as read PDFs, upload files, or edit text unless the example shows a distinctive advantage. Do not add Docker setup, reverse-proxy configuration, OIDC rollout, editor-library names, or SMB protocol internals to this page. Those homepage topics serve other audiences.

### Benefits First, Workflow Details Later

Use the homepage's confident positioning. Tell readers what becomes easier and why it matters. For desktop editing, the promise is:

> Work on network files in Word, Photoshop, LibreOffice, or another installed app. Sambee Companion handles the file handoff and uploads your finished edits back to their source, so you do not have to manage a separate download-and-upload workflow.

The benefits page sells the outcome; linked task pages explain how to complete it. Present uploading back to the original share as a distinctive benefit, not automatic synchronization. Keep Done Editing controls, conflict handling, recovery cases, format details, and other procedural information in those instructions rather than interrupting the benefit with warnings.

Choose vivid examples from the [format reference](../website/content/docs/2.0/user-guide/reference/supported-file-formats/index.md) and task documentation: preview a Photoshop design from your phone, inspect an image inside a ZIP, or update a rendered Markdown table. Lead with what users gain, not a list of qualifications.

### Brief Starting Point

End the benefits page with one clear link to a useful browser-only task, such as previewing an image or inspecting a ZIP without extracting it. Choose a task supported by the target version that read-only users can complete without Companion. Add a short link to connection guidance for missing connections or access.

Do not create a separate generic first-file tutorial. Do not add steps for opening the website, browsing familiar folders, using standard controls, or returning to the file list. Sign-in and account details remain in linked account or troubleshooting guidance.

## Guide Landing Page

Rewrite the current [User Guide landing page](../website/content/docs/0.7/user-guide/_index.md) as a short task directory.

- Link to What Is Sambee? for the definition and What Can You Do With Sambee? for practical benefits.
- Offer links for finding files, organizing files, viewing and editing, optional desktop features, and help.
- Use outcome descriptions rather than explain the guide itself through a list of generic learning goals.
- Keep links to the Admin Guide and Developer Guide for deployment, policy, and implementation questions.
- Do not duplicate the canonical product definition, the benefits page, or a long feature list.

## Page-Level Changes

### Connections and Browsing

Start Connect to an SMB Share with a short note about choosing an available connection. Do not teach familiar folder navigation. Keep Add a Connection as a later procedure with only non-obvious settings guidance where still accurate.

Explain what to do when no connection is available. Keep the distinction between shared visibility, user access, and read-only operation clear where it affects a task.

SMB access through Sambee does not require Companion. State this near the beginning, not only in desktop setup documentation.

### Selection, Search, and Navigation

Move selection guidance out of the Quick Bar page into a clearly named browsing topic. Explain the non-obvious difference between opening an item and selecting it for a bulk action. A standalone page is optional; do not repeat standard mouse or keyboard behavior unless Sambee differs.

Refocus the Quick Bar content on finding files, jumping to folders, returning to recent locations, and locating commands. The visible title should explain these tasks. Keep Quick Bar as the name of the control in the procedure.

Keep the search boundary near the search steps: File Search uses files loaded in the active directory and the user's recent-file history. It is not a global file index.

Move administrator retention and exclusion policy instructions to suitable Admin Guide content. Keep personal history clearing in Account and Preferences, with a link from the navigation page.

Remove ranking algorithm details from the user guide, including Reference. Keep only behavior that affects a user decision and concise recovery actions. Preserve the explanation that deleting a history entry does not delete a file or folder.

### Copy, Move, Upload, Download, and Archives

Create a task-focused home for copy and move procedures. Keep Dual-Pane Mode focused on arranging and controlling the two panes, with links to copy and move tasks.

Move Download and Upload Files to Organize and Transfer Files. Preserve existing limits, conflict choices, and partial-operation guidance.

Group ZIP browsing, selected-member downloads, extraction, and persistent archive creation under Work with ZIP Archives. Explain the difference between downloading a generated ZIP and creating an archive in storage.

Keep capability limits beside the relevant steps. Archive members cannot be moved, and archive creation has destination restrictions. Do not infer unsupported local-drive or cross-connection behavior.

Preserve concise warnings about partial moves, cancellations, retained sources, and uncertain results at the relevant actions. Link to shared recovery guidance instead of repeating failure details or transfer internals. Reorganization must not weaken data-safety instructions.

### Viewing and Browser Editing

Keep image and document guidance focused on useful capabilities and non-obvious behavior. Do not explain standard zoom, scrolling, or clearly labeled viewer controls. Remove conversion and PDF processing internals; keep task-relevant differences between displayed resources and originals.

Add a discoverable text-editing topic focused on storage, saving, locks, and unsaved-change behavior where they differ from user expectations. Do not teach typing or standard search and replace. Create a separate page only if the non-obvious behavior warrants one; otherwise use a subsection and link to existing recovery and format guidance.

Keep Markdown editing as a dedicated procedure. Link from the viewing page rather than duplicate it.

Keep lock handling, conflict resolution, and draft recovery easy to reach from editing procedures. Avoid placing all warnings in a separate page without links at the point where the user needs them.

### Mobile Sharing and Location Links

Keep Mobile Navigation focused on the compact interface and device differences. Make sharing discoverable through Share Files and Links in Organize and Transfer Files.

Consolidate sharing guidance and explain only consequential differences between stored files, displayed viewer resources, current text, and a location link. Do not teach the device's standard share sheet.

Keep browser and device limits, the download fallback, and the distinction between saved files and unsaved text. A shared location link does not grant access to its connection or file.

Do not teach standard browser Back or bookmarks. Document only Sambee-specific navigation behavior and the warning that history does not undo saved changes or restore discarded edits. Link to shared guidance from mobile content where needed.

### Optional Desktop Features

Group Companion installation, local drives, desktop editing, and the app picker in Use Local Drives and Desktop Apps.

Explain the two desktop editing paths: local files open from their original local path; SMB files use a temporary local copy with a controlled upload step.

Retain the explicit Done Editing upload procedure. Closing the desktop application alone does not upload an SMB edit or complete its session.

Link from View and Edit Files to the desktop editing procedure. Do not maintain two copies of that procedure.

Explain supported desktop, pairing, and installed-application requirements. Do not imply that local-drive access or native-app integration is available on phones.

### Account and Preferences

Move [Manage Your Account](../website/content/docs/2.0/user-guide/getting-started/manage-your-account/index.md) out of Getting Started.

Keep identity review, sign-out, local password changes, and other-session revocation in this page. A brief sign-in section can remain here as reference, but account instructions must not interrupt the benefits page.

Use action-focused explanations for password and OIDC users. Preserve distinctions between clearing a local browser token, revoking an OIDC browser session, and signing out of the identity provider.

Keep user-relevant cases such as the absence of a password section. Move deeper authentication operations to the Admin Guide or link to the existing operations page.

Group personal file browser preferences in this section where appropriate. Verify which settings are personal and which require administrator access before assigning them to a page.

### Troubleshooting and Reference

Organize Common User Problems by symptoms and tasks: cannot sign in, cannot see a connection, cannot open a file, cannot save, cannot complete a transfer, cannot pair Companion, or cannot share.

Give specific recovery actions and links back to the task. Retain technical detail when it changes what the user should do. Avoid moving every exceptional case away from its procedure.

Keep formats and syntax-highlighting details in Reference. Keep Keyboard Navigation and Shortcuts in browsing unless its size justifies a separate reference; do not create duplicate shortcut tables.

## Accuracy Requirements

| Topic | Required Boundary |
|---|---|
| SMB access | The browser accesses SMB storage through the Sambee server; Companion is not required for this path. |
| Local drives | Access requires the supported desktop Companion path and the relevant browser trust approval. |
| Mobile | Browser tasks can be useful on phones and tablets; desktop-only local access and native-app features must not be presented as mobile capabilities. |
| File search | Do not describe it as a global index or imply that it searches file contents. |
| Desktop edits | SMB changes require the explicit upload action. Closing the application is not enough. |
| Sharing | Sharing a location does not grant access. Sharing behavior depends on the device, browser, and selected resource. |
| Transfers | Cancellation and failure can leave partial results. Keep instructions for inspecting the source and destination. |
| Storage | Do not imply that Sambee requires migrating all files into a new storage system. Do not claim that it never creates temporary copies. |
| Product claims | Make confident promises about supported benefits and keep the File Explorer replacement comparison. Do not invent capabilities, claim complete feature parity, or guarantee external outcomes such as search ranking or AI inclusion. |

## Version and Inheritance Plan

General editorial improvements belong at the earliest applicable version, normally 0.7 for existing base content. A feature-specific procedure belongs at the first version that supports that feature.

Do not place the latest feature list into the oldest overview without checking capability history. The overview has authored content in 1.0, so a base-page improvement alone will not update every later version.

Manage Your Account has authored content in 0.9 and 2.0. Preserve both versions' content during the move. Later authored pages must not be replaced with older inherited text.

The docs editor can propagate moves through inherited-only descendants. It can refuse a move when a later version has authored source content, a destination already exists, or a destination section is missing. Inspect the preview and plan coordinated operations for those versions. Do not assume that all later pages need to be materialized.

Before implementation, choose whether the structural reorganization applies across the applicable documentation versions or only to 2.0. If only 2.0 is selected, preserve older navigation and use the tool's materialization workflow where required. If feature introduction dates remain uncertain, ask before assigning content to a version.

## Implementation Sequence

### Phase 1: Confirm the Content Map

1. Confirm the target versions and final section titles.
2. Check each affected page's inherited source and authored overrides.
3. Apply the brevity content test and confirm which topics justify new pages rather than subsections.
4. Verify feature availability for the benefits examples and identify only non-obvious starting-point and text-editing behavior that needs explanation.

### Phase 2: Establish the Introduction

1. Improve What Is Sambee? within its current sections, preserving their order and heading hierarchy.
2. Add What Can You Do With Sambee? as the second page, with concise outcomes, task links, and a brief starting point linking to one useful browser-only task.
3. Update the guide landing page without duplicating the definition or benefits.
4. Check that browser-only and read-only users can identify useful outcomes without Companion setup.

### Phase 3: Reorganize the Guide

1. Create or rename sections with the docs editor.
2. Move account management, transfers, local-drive access, and desktop editing to their task groups.
3. Extract selection, copy and move, archive, and sharing procedures only where they need a clearer home.
4. Update section introductions, navigation order, internal links, and managed redirects.

### Phase 4: Improve the Procedures

1. Add concise text-editing guidance as a subsection or justified standalone page.
2. Remove obvious instructions and unnecessary technical detail instead of moving them later or into Reference.
3. Consolidate duplicated instructions and preserve data-safety warnings.
4. Relocate administrator policy guidance and update cross-guide links.
5. Review mobile paths and optional desktop requirements.

### Phase 5: Validate and Review

1. Run the relevant docs validation and build checks.
2. Refresh required derived documentation artifacts through the repository workflow.
3. Inspect generated navigation, moved-page links, redirects, and inherited content in each affected version.
4. Review the rendered definition page and its metadata.
5. Verify the benefits examples and the linked starting-point task against the application.
6. Apply the style guide's content test and Author and AI Review check, then verify the accuracy requirements above.

Use the [Docs Editor Tool](../website/content/docs/0.9/website-dev-guide/authoring-and-tooling/docs-editor-tool/index.md) for published page, section, and book structural changes. Preview each operation before applying it. The tool runs docs validation after a successful apply. Update Markdown links and managed redirects separately where needed.

Follow the [Docs Style Guide](../website/content/docs/0.7/website-dev-guide/authoring-and-tooling/docs-style-guide/index.md) for published copy. Use simple, accurate language and consistent list styles.

For application checks in the VS Code browser, use only `http://localhost:3000/browse/smb/demo`, as required by the repository instructions. No application UI changes are part of this plan.

## Acceptance Criteria

- What Is Sambee? remains the first page and contains a short definition that can be understood without surrounding text.
- Its current section order and heading hierarchy are preserved; improvements do not replace the page's structure.
- The definition names the product category, existing storage, browser tasks, and the optional Companion role.
- The opening and desktop benefit emphasize editing network files in installed apps and uploading changes back to the original share without managing downloaded copies or choosing an upload destination. They do not imply automatic synchronization.
- The File Explorer replacement comparison is retained, and the definition and benefits pages use confident marketing language without unnecessary caveats or invented capabilities.
- Benefits use concrete tasks and link to the relevant instructions.
- No screenshots are added to the docs; concrete examples and task links demonstrate the benefits.
- The benefits page uses distinctive homepage-backed scenarios, including unusual image previews, ZIP inspection without full extraction, rendered Markdown table editing, direct directory navigation, and desktop editing back to the source share.
- The existing-storage benefit is clear, and generic file-manager actions or administrator deployment topics do not displace the distinctive examples.
- Every passage passes the style guide's content test; obvious controls and unnecessary implementation detail are not explained.
- Numbered steps are used only for non-obvious workflows where order matters.
- Short related topics use subsections unless a distinct page is justified, and control lists or shortcut tables are not duplicated.
- There is no competing full product introduction in the user guide.
- What Can You Do With Sambee? is the second Getting Started page and explains practical outcomes without repeating the definition or feature catalog.
- The benefits page ends with one clear link to a useful browser-only task that read-only users can complete without Companion; no separate generic first-file tutorial is added.
- Browser-only and read-only users can identify useful benefits without Companion setup.
- Manage Your Account appears later under Account and Preferences.
- Selection, search, copy, move, upload, download, and archive tasks can be found without knowing a control or layout name.
- Text editing has concise, discoverable task guidance, not a tutorial on standard editor controls.
- Mobile sharing is easy to find and does not imply universal device support or access grants.
- Administrator policy instructions do not interrupt basic user procedures.
- Local-drive and desktop-app requirements remain explicit.
- Upload, conflict, cancellation, lock, and recovery warnings remain accurate and accessible.
- Inheritance and authored overrides are preserved for every affected version.
- Moved URLs have the required link and redirect updates.
- Required docs checks pass, and the benefits examples and the linked starting-point task match the application.

## Decisions Still Needed

| Decision | Recommended Default |
|---|---|
| Version scope | Apply general improvements at the earliest applicable version and preserve later feature-specific overrides; confirm the scope before structural changes. |
| Getting Started page roles | Keep What Is Sambee? and its current structure; add What Can You Do With Sambee? as the benefits-focused second page. |
| Section names | Use the task-based names in this plan. |
| Page count | Prefer clear subsections; create pages only for distinct user value or substantial non-obvious behavior. |
| Personal preferences | Keep them together under Account and Preferences; verify ownership before moving settings guidance. |
| Search metadata changes | Inspect existing output first; change templates only for a demonstrated problem. |

The proposed structure and copy require implementation review. This document records the full plan; it does not apply the reorganization.
