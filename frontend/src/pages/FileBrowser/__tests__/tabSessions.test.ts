import { describe, expect, it } from "vitest";
import { FileType } from "../../../types";
import { physicalItem, physicalLocation } from "../contentProviders";
import {
  closeTabInCollection,
  createEmptyTabSession,
  createInitialTabCollection,
  createTabAfterSelected,
  evictOverflowTabListings,
  getAdjacentTabId,
  getPaneTabFullLocation,
  getPaneTabLabel,
  hydrateTabCollection,
  restoreClosedTabInCollection,
  selectTabInCollection,
} from "../tabSessions";

const sampleEntry = {
  name: "report.pdf",
  path: "Reports/report.pdf",
  type: FileType.FILE,
  size: 128,
  is_readable: true,
  is_hidden: false,
};

describe("tabSessions", () => {
  it("inserts a new tab immediately after the selected tab and copies location and sort without selection or scroll", () => {
    const initial = hydrateTabCollection(
      [
        createEmptyTabSession("t1", {
          connectionId: "conn-1",
          currentPath: "Reports",
          sortBy: "modified",
          sortDirection: "desc",
          selectedFiles: new Set(["Reports/report.pdf"]),
          scrollOffset: 240,
          focusedIndex: 4,
          navigationHistory: new Map([["", { focusedIndex: 1, scrollOffset: 40, selectedFileName: "Reports" }]]),
        }),
        createEmptyTabSession("t2", {
          connectionId: "conn-1",
          currentPath: "Images",
        }),
      ],
      "t1"
    );

    const { collection, createdTab } = createTabAfterSelected(initial, { id: "t-mid" });

    expect(collection.orderedIds).toEqual(["t1", "t-mid", "t2"]);
    expect(collection.selectedTabId).toBe("t-mid");
    expect(createdTab.connectionId).toBe("conn-1");
    expect(createdTab.currentPath).toBe("Reports");
    expect(createdTab.sortBy).toBe("modified");
    expect(createdTab.sortDirection).toBe("desc");
    expect(createdTab.selectedFiles.size).toBe(0);
    expect(createdTab.scrollOffset).toBe(0);
    expect(createdTab.focusedIndex).toBe(0);
    expect(createdTab.navigationHistory.size).toBe(0);
  });

  it("clones archive location without sharing mutable references on tab creation", () => {
    const archiveLocation = { providerId: "zip" as const, archivePath: "Archives/bundle.zip", virtualPath: "docs" };
    const initial = hydrateTabCollection(
      [
        createEmptyTabSession("t1", {
          connectionId: "conn-1",
          currentPath: "Archives",
          archiveLocation,
          selectedFiles: new Set(["docs/readme.md"]),
        }),
      ],
      "t1"
    );

    const { createdTab } = createTabAfterSelected(initial, { id: "t2" });
    expect(createdTab.archiveLocation).toEqual(archiveLocation);
    expect(createdTab.archiveLocation).not.toBe(archiveLocation);
    expect(createdTab.selectedFiles.size).toBe(0);
  });

  it("applies neighbor selection and last-tab protection rules when closing tabs", () => {
    const fourTabs = hydrateTabCollection(
      [
        createEmptyTabSession("t1", { connectionId: "conn-1", currentPath: "One" }),
        createEmptyTabSession("t2", { connectionId: "conn-1", currentPath: "Two" }),
        createEmptyTabSession("t3", { connectionId: "conn-1", currentPath: "Three" }),
        createEmptyTabSession("t4", { connectionId: "conn-1", currentPath: "Four" }),
      ],
      "t1"
    );

    // Selected first tab with right neighbor -> selects right neighbor ("t2")
    const afterCloseFirst = closeTabInCollection(fourTabs, "t1");
    expect(afterCloseFirst.closed).toBe(true);
    if (!afterCloseFirst.closed) throw new Error("Expected close");
    expect(afterCloseFirst.collection.orderedIds).toEqual(["t2", "t3", "t4"]);
    expect(afterCloseFirst.collection.selectedTabId).toBe("t2");
    expect(afterCloseFirst.closedIndex).toBe(0);

    // Selected middle/last tab with left neighbor -> selects left neighbor
    const selectedMiddle = selectTabInCollection(afterCloseFirst.collection, "t3").collection;
    const afterCloseMiddle = closeTabInCollection(selectedMiddle, "t3");
    expect(afterCloseMiddle.closed).toBe(true);
    if (!afterCloseMiddle.closed) throw new Error("Expected close");
    expect(afterCloseMiddle.collection.orderedIds).toEqual(["t2", "t4"]);
    expect(afterCloseMiddle.collection.selectedTabId).toBe("t2");

    // Unselected background tab -> preserves selected tab
    const afterCloseBackground = closeTabInCollection(afterCloseMiddle.collection, "t4");
    expect(afterCloseBackground.closed).toBe(true);
    if (!afterCloseBackground.closed) throw new Error("Expected close");
    expect(afterCloseBackground.selectionChanged).toBe(false);
    expect(afterCloseBackground.collection.orderedIds).toEqual(["t2"]);
    expect(afterCloseBackground.collection.selectedTabId).toBe("t2");

    // Only remaining tab -> cannot be closed
    const attemptLastClose = closeTabInCollection(afterCloseBackground.collection, "t2");
    expect(attemptLastClose.closed).toBe(false);
    expect(attemptLastClose.collection.orderedIds).toEqual(["t2"]);
  });

  it("restores closed tabs at clamped positions and marks restored content for revalidation", () => {
    const initial = hydrateTabCollection(
      [
        createEmptyTabSession("t1", { connectionId: "conn-1", currentPath: "One" }),
        createEmptyTabSession("t2", {
          connectionId: "conn-1",
          currentPath: "Two",
          hasPhysicalListing: true,
          listingTimestamp: 12_345,
          scrollOffset: 180,
          selectedFiles: new Set(["Two/a.txt"]),
        }),
        createEmptyTabSession("t3", { connectionId: "conn-1", currentPath: "Three" }),
      ],
      "t2"
    );

    const closed = closeTabInCollection(initial, "t2");
    if (!closed.closed) throw new Error("Expected close");
    const afterAnotherClose = closeTabInCollection(closed.collection, "t3");
    if (!afterAnotherClose.closed) throw new Error("Expected close");

    // Restore original closed session with an index beyond current length -> clamps cleanly
    const { collection, restoredTab } = restoreClosedTabInCollection(afterAnotherClose.collection, closed.closedSession, 10);
    expect(collection.orderedIds).toEqual(["t1", "t2"]);
    expect(collection.selectedTabId).toBe("t2");
    expect(restoredTab.listingTimestamp).toBe(12_345);
    expect(restoredTab.invalidated).toBe(true);
    expect(restoredTab.unmonitoredWhileHidden).toBe(true);
    expect(restoredTab.scrollOffset).toBe(180);
    expect([...restoredTab.selectedFiles]).toEqual(["Two/a.txt"]);
  });

  it("evicts least-recently-used inactive listings while keeping lightweight location and selection metadata", () => {
    const item = physicalItem(physicalLocation("conn-1", "Reports"), sampleEntry);
    const collection = hydrateTabCollection(
      [
        createEmptyTabSession("t1", {
          connectionId: "conn-1",
          currentPath: "One",
          items: [item],
          hasPhysicalListing: true,
          listingTimestamp: 100,
          selectedFiles: new Set(["Reports/report.pdf"]),
          focusedItemIdentity: "Reports/report.pdf",
          scrollOffset: 320,
        }),
        createEmptyTabSession("t2", {
          connectionId: "conn-1",
          currentPath: "Archives",
          archiveLocation: { providerId: "zip", archivePath: "Archives/a.zip", virtualPath: "sub" },
          items: [item],
          hasArchiveListing: true,
          archiveNextCursor: "cursor-2",
          archiveHasMore: true,
          scrollOffset: 120,
        }),
        createEmptyTabSession("t3", {
          connectionId: "conn-1",
          currentPath: "Three",
          items: [item],
          hasPhysicalListing: true,
          listingTimestamp: 300,
        }),
      ],
      "t3",
      1
    );

    const bounded = evictOverflowTabListings(collection, 1);
    const evictedFirst = bounded.sessions.get("t1")!;
    expect(evictedFirst.evicted).toBe(true);
    expect(evictedFirst.items).toEqual([]);
    expect(evictedFirst.hasPhysicalListing).toBe(false);
    expect(evictedFirst.currentPath).toBe("One");
    expect([...evictedFirst.selectedFiles]).toEqual(["Reports/report.pdf"]);
    expect(evictedFirst.focusedItemIdentity).toBe("Reports/report.pdf");
    expect(evictedFirst.scrollOffset).toBe(320);

    // Switch so t2 becomes oldest inactive and gets evicted: incomplete archive cursor must reset cleanly
    const afterSelectT1 = selectTabInCollection(bounded, "t1", 1).collection;
    const evictedArchive = afterSelectT1.sessions.get("t2")!;
    expect(evictedArchive.evicted).toBe(true);
    expect(evictedArchive.items).toEqual([]);
    expect(evictedArchive.hasArchiveListing).toBe(false);
    expect(evictedArchive.archiveNextCursor).toBeNull();
    expect(evictedArchive.archiveHasMore).toBe(false);
    expect(evictedArchive.archiveLocation?.virtualPath).toBe("sub");
  });

  it("wraps adjacent tab traversal at both ends and leaves a single tab unchanged", () => {
    const single = createInitialTabCollection("only");
    expect(getAdjacentTabId(single.orderedIds, "only", "previous")).toBe("only");
    expect(getAdjacentTabId(single.orderedIds, "only", "next")).toBe("only");

    const ids = ["a", "b", "c"];
    expect(getAdjacentTabId(ids, "a", "previous")).toBe("c");
    expect(getAdjacentTabId(ids, "c", "next")).toBe("a");
    expect(getAdjacentTabId(ids, "b", "next")).toBe("c");
  });

  it("derives compact labels and full location strings for roots, folders, and archives", () => {
    expect(getPaneTabLabel({ connectionId: "conn-1", currentPath: "", archiveLocation: null }, "Demo")).toBe("Demo");
    expect(getPaneTabLabel({ connectionId: "conn-1", currentPath: "Projects/2026/Reports", archiveLocation: null }, "Demo")).toBe(
      "Reports"
    );
    expect(
      getPaneTabLabel(
        {
          connectionId: "conn-1",
          currentPath: "Exports",
          archiveLocation: { providerId: "zip", archivePath: "Exports/bundle.zip", virtualPath: "" },
        },
        "Demo"
      )
    ).toBe("bundle.zip");
    expect(
      getPaneTabLabel(
        {
          connectionId: "conn-1",
          currentPath: "Exports",
          archiveLocation: { providerId: "zip", archivePath: "Exports/bundle.zip", virtualPath: "nested/Alpha" },
        },
        "Demo"
      )
    ).toBe("Alpha");
    expect(
      getPaneTabFullLocation(
        {
          connectionId: "conn-1",
          currentPath: "Exports",
          archiveLocation: { providerId: "zip", archivePath: "Exports/bundle.zip", virtualPath: "nested/Alpha" },
        },
        "Demo"
      )
    ).toBe("Demo:/Exports/bundle.zip/nested/Alpha");
  });
});
