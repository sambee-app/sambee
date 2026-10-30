# User Guide Change Proposal

## Status and Purpose

Status: Proposal for implementation review. This document does not change the published user guide.

The user guide must help new users understand what Sambee can do for them, then help them complete useful file tasks. It must also contain one clear definition page that search engines and AI systems can identify and quote.

This plan combines the proposed guide reorganization, the benefit-led introduction, the canonical product definition, and the related page improvements.

The version scope still needs a decision. The proposals are not permission to change every documentation version or to change application behavior.

## Goals

- Explain what Sambee is in a short, accurate, standalone definition.
- Show concrete benefits before detailed controls and technical explanations.
- Help a new user open and use a file without first learning account administration or installing Companion.
- Make everyday tasks easy to find by their names.
- Keep desktop enhancements optional and explain their requirements.
- Preserve warnings that prevent data loss, incomplete transfers, and incorrect assumptions about access.
- Use version inheritance to avoid unnecessary copies of documentation.

## Scope

The proposed changes cover the user guide landing page, its section order, page placement, task instructions, and links to related guides. They include moving administrator-only explanations out of user task pages where suitable documentation exists or needs a coordinated update.

They do not include a new marketing website, application changes, new product capabilities, or a general rewrite of the Admin Guide. Search metadata or template changes are follow-up work only if an inspection identifies a specific problem.

## Current Problems

| Problem | Evidence | Proposed Response |
|---|---|---|
| Account management is the second Getting Started page. | [Current navigation](../website/data/docs-nav/2.0.toml) lists the overview, then account management. | Replace the second position with a first-use walkthrough. Move account management later. |
| The overview lists capabilities but gives no first task sequence. | [What Is Sambee?](../website/content/docs/1.0/user-guide/getting-started/what-is-sambee/index.md) describes viewers, editors, and desktop integration. | Keep this as the definition page, add benefits and task links, then link to a walkthrough. |
| Connection setup comes before using a connection. | [Connect to an SMB Share](../website/content/docs/0.7/user-guide/accessing-files/connect-to-an-smb-share/index.md) starts with settings and adding a connection. | Explain how to open an available connection first. Keep adding a connection as a separate procedure. |
| Basic tasks are grouped under feature names. | Selection is in [Smart Navigation and the Quick Bar](../website/content/docs/2.0/user-guide/browsing-and-navigation/smart-navigation-and-the-quick-bar/index.md). Copy, move, and extraction are in [Dual-Pane Mode](../website/content/docs/2.0/user-guide/browsing-and-navigation/dual-pane-mode/index.md). | Give these tasks explicit navigation entries or clear task headings in suitable pages. |
| File transfers are grouped with viewing and editing. | [Download and Upload Files](../website/content/docs/1.0/user-guide/viewing-and-editing-files/download-and-upload-files/index.md) is in Viewing & Editing Files. | Move it to Organize and Transfer Files. |
| User instructions contain detailed operational explanations. | The Quick Bar page covers history ranking, retention policy, administrator settings, and many recovery cases. | Keep the user steps and limits visible. Move administrator policy details to the Admin Guide and place deeper behavior after basic tasks. |
| Text editing has no dedicated task page. | The overview describes text editing, but the navigation has a Markdown page and text-format reference rather than a text-editing procedure. | Add View and Edit Text Files, linked to the format reference. |
| Some preview details precede the user actions. | [View Images & Read Documents](../website/content/docs/0.7/user-guide/viewing-and-editing-files/view-images-and-read-documents/index.md) explains image processing before viewer controls. | Explain opening and using the viewer first. Keep processing details later where they help explain visible behavior. |

## Proposed Guide Structure

Use the following section order. Page titles below are proposed editorial titles, not final URL instructions.

| Order | Section | Proposed Pages or Topics |
|---|---|---|
| 1 | Getting Started | What Is Sambee?; Open Your First File |
| 2 | Find and Browse Files | Open Connections and Browse Folders; Select Files and Folders; Find Files and Return to Recent Locations; Mobile Navigation; Dual-Pane Mode; Keyboard Navigation and Shortcuts |
| 3 | Organize and Transfer Files | Copy and Move Files; Download and Upload Files; Work with ZIP Archives; Share Files and Links |
| 4 | View and Edit Files | View Images and Read Documents; View and Edit Text Files; Edit Markdown; File Locking and Conflict Resolution; Recover Unsaved Edits |
| 5 | Use Local Drives and Desktop Apps | Install and Pair the Companion App; Access Local Drives; Edit Files in Desktop Apps; Desktop App Picker |
| 6 | Account and Preferences | Manage Your Account; relevant file browser preferences, kept together rather than split into many small pages |
| 7 | Troubleshooting | Common User Problems, grouped by the task that cannot be completed |
| 8 | Reference | Supported File Formats; Text File Support and Syntax Highlighting; detailed shortcut information if it needs a separate reference |

### Structural Decisions

- Remove the separate Accessing Files section. Opening SMB connections belongs with browsing. Local-drive setup belongs with the optional desktop features.
- Rename Browsing and Navigation to Find and Browse Files.
- Add Organize and Transfer Files so readers can find operations without knowing about dual-pane mode.
- Rename Viewing & Editing Files to View and Edit Files.
- Replace the Companion App section with Use Local Drives and Desktop Apps. Explain the benefit in the section title and the dependency in the content.
- Move Manage Your Account to Account and Preferences. It remains user documentation, not administrator documentation.
- Keep Troubleshooting before Reference and link to it from failure points in task pages.
- Keep one procedure for each task. Related pages link to it rather than repeat it.

The page list is a content map, not a requirement to create a separate page for every small topic. Combine closely related procedures when this improves reading and does not hide a main task.

## Canonical Definition Page

### Role and Identity

Keep What Is Sambee? as the first page in Getting Started. Do not replace its title with What You Can Do With Sambee and do not create a second competing introduction.

This page is the editorial source for the product definition. The guide landing page provides task links and a brief introduction; it does not repeat the full definition and feature explanation.

Editorial canonical status is not an instruction to change HTML canonical URLs. Published version URLs and their metadata must continue to follow the website's version-aware rules.

### Proposed Opening Copy

> Sambee is a self-hosted, browser-based file manager for files on SMB network shares and local drives. It lets users browse files, view images and PDFs, and edit text and Markdown in their browser. Its optional desktop Companion app provides local-drive access and opens files in installed desktop applications, with an explicit upload step to save changes back to a network share.

This is draft copy for versions that support all listed capabilities. Check the capability history before applying it to an older version.

The opening must stand on its own. It names the product, the product category, the storage it uses, the main browser tasks, and the role of Companion.

### Proposed Page Outline

| Part | Purpose | Content |
|---|---|---|
| Opening definition | Answer What is Sambee? directly. | Use the short definition above, without an extra heading that repeats the page title. |
| What Can You Do With Sambee? | Explain the value through tasks. | Give concrete benefits and link to the matching guide pages. |
| How Does Sambee Access Your Files? | Explain the storage model. | Explain existing SMB storage, the self-hosted server, and local access through Companion. |
| Where Can You Use It? | Set correct device expectations. | Distinguish desktop browser, phone, and tablet tasks from supported desktop-only Companion tasks. |
| Get Started | Turn interest into action. | Link to Open Your First File, then to optional desktop setup. |

### Benefits to Explain

- Access existing network files from a PC, phone, or tablet through the Sambee site.
- Read documents and browse photos without downloading each file first.
- Find a folder again through navigation and recent locations.
- Organize files across storage locations with copy and move operations.
- Edit text and Markdown in the browser.
- Use installed desktop applications to edit network files without manually downloading and uploading copies.

Use examples such as reading a PDF, inspecting a photo collection, changing a Markdown document, or editing an office document in an installed application. Do not imply that a named application is bundled or available on every device.

Keep the free and open source statement, but do not let licensing or deployment instructions replace the explanation of user value.

### Search and AI Readability

- Use the stable title What Is Sambee? and an explicit opening sentence beginning with Sambee is.
- Use consistent terms such as self-hosted file manager, browser-based file manager, SMB network shares, and Sambee Companion where they fit naturally.
- Use meaningful headings and short, self-contained paragraphs that can be understood outside the page.
- Put the definition in ordinary page text, not only in an image, tooltip, or interactive element.
- Link from the user guide landing page to this definition page.
- Avoid keyword repetition, vague superlatives, and claims such as replaces File Explorer without clear limits.
- Do not promise that search engines will rank the page or that AI systems will quote it.

During implementation, verify the generated page title, description if supported, indexability, and version-aware canonical behavior. Use the existing website mechanisms. Do not introduce structured data or template changes without a verified need.

## First-Use Walkthrough

### Open Your First File

The second Getting Started page must produce a useful result without requiring connection administration or Companion installation.

Recommended sequence:

1. Open the Sambee address provided for the installation. Sign in if the site requests it.
2. Choose an available SMB connection from the Connection List.
3. Open a folder and select a suitable image, PDF, text file, or Markdown file.
4. Open the file in the browser and use a relevant viewer control.
5. Download the file if a local copy is useful.
6. Return to the folder and choose a next task from the guide.

Before writing the final procedure, verify the visible controls and device-specific actions. Use the mouse or touch path first; give shortcuts as alternatives.

Explain the empty-connection case briefly. Link to the connection procedure if the user can add a connection, or tell the user to ask an administrator for access. Do not assume every new user must create a connection.

Do not ask the reader to edit or move a file in the introductory walkthrough. Read-only access must still provide a useful first experience.

Keep sign-in help short. Link to Manage Your Account for password changes and session control. Link to troubleshooting if sign-in or access fails.

## Guide Landing Page

Rewrite the current [User Guide landing page](../website/content/docs/0.7/user-guide/_index.md) as a short task directory.

- Give readers a clear choice between learning what Sambee is and opening their first file.
- Offer links for finding files, organizing files, viewing and editing, optional desktop features, and help.
- Use outcome descriptions rather than explain the guide itself through a list of generic learning goals.
- Keep links to the Admin Guide and Developer Guide for deployment, policy, and implementation questions.
- Do not duplicate the canonical product definition or create another long feature list.

## Page-Level Changes

### Connections and Browsing

Change Connect to an SMB Share into a page that starts with opening an available connection and browsing its folders. Keep Add a Connection as a later procedure with its current settings guidance where still accurate.

Explain why the reader would choose a connection and what to do when none is available. Keep the distinction between shared visibility, user access, and read-only operation clear.

SMB access through Sambee does not require Companion. State this near the beginning, not only in desktop setup documentation.

### Selection, Search, and Navigation

Move desktop and touch selection instructions out of the Quick Bar page into Select Files and Folders, or a clearly named basic browsing page. Preserve the difference between opening an item and selecting it for a bulk action.

Refocus the Quick Bar content on finding files, jumping to folders, returning to recent locations, and locating commands. The visible title should explain these tasks. Keep Quick Bar as the name of the control in the procedure.

Keep the search boundary near the search steps: File Search uses files loaded in the active directory and the user's recent-file history. It is not a global file index.

Move administrator retention and exclusion policy instructions to suitable Admin Guide content. Keep personal history clearing in Account and Preferences, with a link from the navigation page.

Put ranking details and extended recovery behavior after the core steps or in linked reference material. Do not remove the explanation that deleting a history entry does not delete a file or folder.

### Copy, Move, Upload, Download, and Archives

Create a task-focused home for copy and move procedures. Keep Dual-Pane Mode focused on arranging and controlling the two panes, with links to copy and move tasks.

Move Download and Upload Files to Organize and Transfer Files. Preserve existing limits, conflict choices, and partial-operation guidance.

Group ZIP browsing, selected-member downloads, extraction, and persistent archive creation under Work with ZIP Archives. Explain the difference between downloading a generated ZIP and creating an archive in storage.

Keep capability limits beside the relevant steps. Archive members cannot be moved, and archive creation has destination restrictions. Do not infer unsupported local-drive or cross-connection behavior.

Preserve warnings about partial moves, cancellations, retained sources, and uncertain results. Put common outcomes first, with detailed recovery guidance below. Reorganization must not weaken data-safety instructions.

### Viewing and Browser Editing

Start image and document guidance with how to open a file and use the controls. Put format conversion and PDF normalization details later. Keep the distinction between displayed resources and original downloads.

Add View and Edit Text Files. Cover opening, editing, search and replace, saving, and handling unsaved changes after verifying the current controls. Link to Text File Support and Syntax Highlighting for format details.

Keep Markdown editing as a dedicated procedure. Link from the viewing page rather than duplicate it.

Keep lock handling, conflict resolution, and draft recovery easy to reach from editing procedures. Avoid placing all warnings in a separate page without links at the point where the user needs them.

### Mobile Sharing and Location Links

Keep Mobile Navigation focused on the compact interface and device differences. Make sharing discoverable through Share Files and Links in Organize and Transfer Files.

Consolidate, rather than duplicate, the detailed sharing procedure. Explain the differences between sharing stored files, displayed viewer resources, current text, and a location link.

Keep browser and device limits, the download fallback, and the distinction between saved files and unsaved text. A shared location link does not grant access to its connection or file.

Browser Back and bookmarks are not only mobile features. Put their general behavior in basic browsing guidance, then link from the mobile page. Keep warnings that navigation history does not undo saved changes or restore discarded edits.

### Optional Desktop Features

Group Companion installation, local drives, desktop editing, and the app picker in Use Local Drives and Desktop Apps.

Explain the two desktop editing paths: local files open from their original local path; SMB files use a temporary local copy with a controlled upload step.

Retain the explicit Done Editing upload procedure. Closing the desktop application alone does not upload an SMB edit or complete its session.

Link from View and Edit Files to the desktop editing procedure. Do not maintain two copies of that procedure.

Explain supported desktop, pairing, and installed-application requirements. Do not imply that local-drive access or native-app integration is available on phones.

### Account and Preferences

Move [Manage Your Account](../website/content/docs/2.0/user-guide/getting-started/manage-your-account/index.md) out of Getting Started.

Keep identity review, sign-out, local password changes, and other-session revocation in this page. A brief sign-in section can remain here as reference, but it must not replace the first-use walkthrough.

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
| Product claims | Avoid universal application compatibility, unrestricted remote access, automatic synchronization, and guaranteed search or AI visibility. |

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
3. Confirm which topics need new pages and which can share an existing page.
4. Verify feature availability and current controls for the first-use and text-editing procedures.

### Phase 2: Establish the Introduction

1. Update What Is Sambee? with the definition, benefits, limits, and task links.
2. Add Open Your First File.
3. Update the guide landing page without duplicating the definition.
4. Check that a read-only user can complete the introductory task.

### Phase 3: Reorganize the Guide

1. Create or rename sections with the docs editor.
2. Move account management, transfers, local-drive access, and desktop editing to their task groups.
3. Extract selection, copy and move, archive, and sharing procedures only where they need a clearer home.
4. Update section introductions, navigation order, internal links, and managed redirects.

### Phase 4: Improve the Procedures

1. Add text-editing guidance.
2. Put normal user steps before internal explanations.
3. Consolidate duplicated instructions and preserve data-safety warnings.
4. Relocate administrator policy guidance and update cross-guide links.
5. Review mobile paths and optional desktop requirements.

### Phase 5: Validate and Review

1. Run the relevant docs validation and build checks.
2. Refresh required derived documentation artifacts through the repository workflow.
3. Inspect generated navigation, moved-page links, redirects, and inherited content in each affected version.
4. Review the rendered definition page and its metadata.
5. Perform the first-use walkthrough against the application.
6. Review the guide as a new user and check the accuracy requirements above.

Use the [Docs Editor Tool](../website/content/docs/0.9/website-dev-guide/authoring-and-tooling/docs-editor-tool/index.md) for published page, section, and book structural changes. Preview each operation before applying it. The tool runs docs validation after a successful apply. Update Markdown links and managed redirects separately where needed.

Follow the [Docs Style Guide](../website/content/docs/0.7/website-dev-guide/authoring-and-tooling/docs-style-guide/index.md) for published copy. Use simple, accurate language and consistent list styles.

For application checks in the VS Code browser, use only `http://localhost:3000/browse/smb/demo`, as required by the repository instructions. No application UI changes are part of this plan.

## Acceptance Criteria

- What Is Sambee? remains the first page and contains a short definition that can be understood without surrounding text.
- The definition names the product category, existing storage, browser tasks, and the optional Companion role.
- Benefits use concrete tasks and link to the relevant instructions.
- There is no competing full product introduction in the user guide.
- Open Your First File is the second Getting Started page and is useful without Companion or write access.
- Manage Your Account appears later under Account and Preferences.
- Selection, search, copy, move, upload, download, and archive tasks can be found without knowing a control or layout name.
- Text editing has a task procedure, not only a format reference.
- Mobile sharing is easy to find and does not imply universal device support or access grants.
- Administrator policy instructions do not interrupt basic user procedures.
- Local-drive and desktop-app requirements remain explicit.
- Upload, conflict, cancellation, lock, and recovery warnings remain accurate and accessible.
- Inheritance and authored overrides are preserved for every affected version.
- Moved URLs have the required link and redirect updates.
- Required docs checks pass, and the first-use steps match the application.

## Decisions Still Needed

| Decision | Recommended Default |
|---|---|
| Version scope | Apply general improvements at the earliest applicable version and preserve later feature-specific overrides; confirm the scope before structural changes. |
| Product definition title | Keep What Is Sambee? and its stable identity. |
| Section names | Use the task-based names in this plan. |
| Page count | Create pages for substantial missing tasks, but combine closely related short procedures. |
| Personal preferences | Keep them together under Account and Preferences; verify ownership before moving settings guidance. |
| Search metadata changes | Inspect existing output first; change templates only for a demonstrated problem. |

The proposed structure and copy require implementation review. This document records the full plan; it does not apply the reorganization.
