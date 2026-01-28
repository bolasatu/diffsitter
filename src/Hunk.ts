import { Entry } from './TreeSitterProcessor';

/**
 * Error types for hunk insertion operations.
 * Mirrors Rust HunkInsertionError enum from diff.rs
 */
export class HunkInsertionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'HunkInsertionError';
    }
}

export class NonAdjacentHunkError extends HunkInsertionError {
    constructor(
        public readonly incomingLine: number,
        public readonly lastLine: number
    ) {
        super(`Non-adjacent entry (line ${incomingLine}) added to hunk (last line: ${lastLine})`);
        this.name = 'NonAdjacentHunkError';
    }
}

export class PriorLineError extends HunkInsertionError {
    constructor(
        public readonly incomingLine: number,
        public readonly lastLine: number
    ) {
        super(`Attempted to append an entry with a line index (${incomingLine}) less than the first line's index (${lastLine})`);
        this.name = 'PriorLineError';
    }
}

export class PriorColumnError extends HunkInsertionError {
    constructor(
        public readonly incomingCol: number,
        public readonly incomingLine: number,
        public readonly lastCol: number,
        public readonly lastLine: number
    ) {
        super(`Attempted to append an entry with a column (${incomingCol}, line: ${incomingLine}) less than the first entry's column (${lastCol}, line: ${lastLine})`);
        this.name = 'PriorColumnError';
    }
}

/**
 * The edit information representing a line.
 * Mirrors Rust Line struct from diff.rs
 */
export interface Line {
    /** The index of the line in the original document */
    lineIndex: number;

    /** The entries corresponding to the line */
    entries: Entry[];
}

/**
 * Create a new Line instance.
 */
export function createLine(lineIndex: number): Line {
    return {
        lineIndex,
        entries: []
    };
}

/**
 * A grouping of consecutive edit lines for a document.
 * Every line in a hunk must be consecutive and in ascending order.
 * Mirrors Rust Hunk struct from diff.rs
 */
export class Hunk {
    private lines: Line[];

    constructor(lines: Line[] = []) {
        this.lines = lines;
    }

    /**
     * Get the internal lines array.
     */
    getLines(): Line[] {
        return this.lines;
    }

    /**
     * Returns the first line number of the hunk.
     * Returns undefined if the internal array is empty.
     */
    firstLine(): number | undefined {
        return this.lines[0]?.lineIndex;
    }

    /**
     * Returns the last line number of the hunk.
     * Returns undefined if the internal array is empty.
     */
    lastLine(): number | undefined {
        return this.lines[this.lines.length - 1]?.lineIndex;
    }

    /**
     * Check if an entry can be pushed onto the current hunk.
     * 
     * This method is exposed so users can check if the push back operation would fail.
     * This is useful if you want to avoid needing to do extra copies in case an incoming
     * entry can't be added to the entry and you don't want to have to deal with copying
     * the entry for the next hunk.
     * 
     * @throws {HunkInsertionError} with the specific reason the entry couldn't be inserted.
     */
    canPushBack(entry: Entry): void {
        const incomingLineIdx = entry.startPosition.row;

        // Create a new line if the incoming entry is on the next line. This will throw an error
        // if we have an entry on a non-adjacent line or an out-of-order insertion.
        if (this.lines.length > 0) {
            const lastLine = this.lines[this.lines.length - 1];
            const lastLineIdx = lastLine.lineIndex;

            if (incomingLineIdx < lastLineIdx) {
                throw new PriorLineError(incomingLineIdx, lastLineIdx);
            } else if (incomingLineIdx - lastLineIdx > 1) {
                throw new NonAdjacentHunkError(incomingLineIdx, lastLineIdx);
            }

            // Only check the incoming column if the new entry would be appended to the same line
            if (incomingLineIdx === lastLineIdx && lastLine.entries.length > 0) {
                const lastEntry = lastLine.entries[lastLine.entries.length - 1];
                const lastCol = lastEntry.endPosition.column;
                const lastLineRow = lastEntry.endPosition.row;
                const incomingCol = entry.startPosition.column;
                const incomingLineRow = entry.endPosition.row;

                if (incomingCol < lastCol) {
                    throw new PriorColumnError(
                        incomingCol,
                        incomingLineRow,
                        lastCol,
                        lastLineRow
                    );
                }
            }
        }
    }

    /**
     * Append an entry to a hunk.
     * 
     * Entries can only be appended in ascending order (first to last). It is an error to
     * append entries out of order. For example, you can't insert an entry on line 1 after
     * inserting an entry on line 5.
     * 
     * @throws {HunkInsertionError} if the entry cannot be added
     */
    pushBack(entry: Entry): void {
        this.canPushBack(entry);
        const incomingLineIdx = entry.startPosition.row;

        // Don't need to check the other conditions because other scenarios like adding a prior
        // line or a non-adjacent line were already checked.
        if (this.lines.length === 0 ||
            incomingLineIdx - this.lines[this.lines.length - 1].lineIndex === 1) {
            this.lines.push(createLine(incomingLineIdx));
        }

        // This doesn't need to be checked because we add a line if there isn't one already
        const lastLine = this.lines[this.lines.length - 1];
        lastLine.entries.push(entry);
    }

    /**
     * Create a deep clone of this hunk.
     */
    clone(): Hunk {
        const clonedLines = this.lines.map(line => ({
            lineIndex: line.lineIndex,
            entries: [...line.entries]
        }));
        return new Hunk(clonedLines);
    }
}

/**
 * Compare two Line objects for equality.
 */
export function lineEquals(a: Line, b: Line): boolean {
    if (a.lineIndex !== b.lineIndex) return false;
    if (a.entries.length !== b.entries.length) return false;

    // Note: This does reference equality, not deep equality of entries
    for (let i = 0; i < a.entries.length; i++) {
        if (a.entries[i] !== b.entries[i]) return false;
    }

    return true;
}

/**
 * Helper class to build Hunks from an iterator of entries.
 * Mirrors Rust Hunks struct from diff.rs
 */
export class Hunks {
    private hunks: Hunk[];

    constructor() {
        this.hunks = [];
    }

    /**
     * Get all hunks.
     */
    getHunks(): Hunk[] {
        return this.hunks;
    }

    /**
     * Add an entry to the hunks, creating new hunks as needed.
     */
    pushBack(entry: Entry): void {
        if (this.hunks.length > 0) {
            const lastHunk = this.hunks[this.hunks.length - 1];

            try {
                lastHunk.pushBack(entry);
                return;
            } catch (error) {
                // If the entry is not contiguous with the current hunk then we need to start a new one
                if (error instanceof NonAdjacentHunkError) {
                    const newHunk = new Hunk();
                    newHunk.pushBack(entry);
                    this.hunks.push(newHunk);
                    return;
                }
                // Re-throw other errors
                throw error;
            }
        } else {
            // No hunks yet, create the first one
            const newHunk = new Hunk();
            newHunk.pushBack(entry);
            this.hunks.push(newHunk);
        }
    }

    /**
     * Create Hunks from an array of entries.
     * The entries must be in proper order, otherwise this will throw.
     */
    static fromEntries(entries: Entry[]): Hunks {
        const hunks = new Hunks();
        for (const entry of entries) {
            hunks.pushBack(entry);
        }
        return hunks;
    }
}

/**
 * A generic type for diffs that source from one of two documents.
 * Mirrors Rust DocumentType enum from diff.rs
 */
export type DocumentType<T> =
    | { type: 'old'; value: T }
    | { type: 'new'; value: T };

/**
 * Create a DocumentType for old (deleted) entries.
 */
export function oldEntry<T>(value: T): DocumentType<T> {
    return { type: 'old', value };
}

/**
 * Create a DocumentType for new (added) entries.
 */
export function newEntry<T>(value: T): DocumentType<T> {
    return { type: 'new', value };
}

/**
 * A hunk with metadata about which document it came from.
 * Mirrors Rust RichHunk type from diff.rs
 */
export type RichHunk = DocumentType<Hunk>;

/**
 * The hunks that correspond to documents, with old/new metadata.
 * Mirrors Rust RichHunks struct from diff.rs
 */
export class RichHunks {
    private hunks: RichHunk[];

    constructor(hunks: RichHunk[] = []) {
        this.hunks = hunks;
    }

    /**
     * Get all hunks.
     */
    getHunks(): RichHunk[] {
        return this.hunks;
    }

    /**
     * Get only the old (deleted) hunks.
     */
    getOldHunks(): Hunk[] {
        return this.hunks
            .filter((h): h is { type: 'old'; value: Hunk } => h.type === 'old')
            .map(h => h.value);
    }

    /**
     * Get only the new (added) hunks.
     */
    getNewHunks(): Hunk[] {
        return this.hunks
            .filter((h): h is { type: 'new'; value: Hunk } => h.type === 'new')
            .map(h => h.value);
    }

    /**
     * Add a hunk.
     */
    push(hunk: RichHunk): void {
        this.hunks.push(hunk);
    }
}

/**
 * Builder for RichHunks.
 * Maintains state for building hunks from edit operations.
 * Mirrors Rust RichHunksBuilder from diff.rs
 */
export class RichHunksBuilder {
    private hunks: RichHunks;
    private lastOld: number | null;
    private lastNew: number | null;

    constructor() {
        this.hunks = new RichHunks();
        this.lastOld = null;
        this.lastNew = null;
    }

    /**
     * Finalize building the hunks.
     */
    build(): RichHunks {
        return this.hunks;
    }

    /**
     * Get or create the hunk for the incoming entry.
     * Creates a new hunk if necessary based on line adjacency.
     */
    private getHunkForInsertion(incomingEntry: DocumentType<Entry>): number {
        const isOld = incomingEntry.type === 'old';
        let lastIdx = isOld ? this.lastOld : this.lastNew;

        const allHunks = this.hunks.getHunks();

        if (lastIdx === null) {
            // No hunk for this type yet, create one
            const newHunk: RichHunk = isOld
                ? { type: 'old', value: new Hunk() }
                : { type: 'new', value: new Hunk() };
            this.hunks.push(newHunk);
            lastIdx = allHunks.length - 1;
        } else {
            // Check if we need a new hunk based on line numbers
            const lastHunk = allHunks[lastIdx].value;
            const lastLine = lastHunk.lastLine();

            if (lastLine !== undefined) {
                const incomingLine = incomingEntry.value.endPosition.row;

                if (incomingLine < lastLine) {
                    throw new PriorLineError(incomingLine, lastLine);
                }

                // If non-adjacent, create a new hunk
                if (incomingLine - lastLine > 1) {
                    const newHunk: RichHunk = isOld
                        ? { type: 'old', value: new Hunk() }
                        : { type: 'new', value: new Hunk() };
                    this.hunks.push(newHunk);
                    lastIdx = allHunks.length - 1;
                }
            }
        }

        // Update tracking
        if (isOld) {
            this.lastOld = lastIdx;
        } else {
            this.lastNew = lastIdx;
        }

        return lastIdx;
    }

    /**
     * Add an entry to the hunks.
     */
    pushBack(entryWrapper: DocumentType<Entry>): void {
        const insertionIdx = this.getHunkForInsertion(entryWrapper);
        const allHunks = this.hunks.getHunks();
        allHunks[insertionIdx].value.pushBack(entryWrapper.value);
    }

    /**
     * Create RichHunks from an array of edit operations.
     * Mirrors Rust TryFrom<Vec<EditType<&Entry>>> for RichHunks
     */
    static fromEdits(edits: Array<{ type: 'addition' | 'deletion'; value: Entry }>): RichHunks {
        const builder = new RichHunksBuilder();
        for (const edit of edits) {
            const docType: DocumentType<Entry> = edit.type === 'deletion'
                ? { type: 'old', value: edit.value }
                : { type: 'new', value: edit.value };
            builder.pushBack(docType);
        }
        return builder.build();
    }
}
