import JavaScript from 'tree-sitter-javascript';
import Parser from "tree-sitter";
import * as fs from 'fs';
import {TreeSitterProcessor} from "./TreeSitterProcessor";

interface AstNode {
    type: string;
    text?: string;
    startPosition: { row: number; column: number };
    endPosition: { row: number; column: number };
    children?: AstNode[];
}

/**
 * Entry represents a mapping between a tree-sitter node and its text.
 * This is the unit of comparison for the diff algorithm.
 * Mirrors the Rust Entry struct from input_processing.rs
 */
interface Entry {
    /** The node type identifier (equivalent to kind_id in Rust) */
    kindId: string;

    /** The text content this entry refers to */
    text: string;

    /** The entry's start position in the document */
    startPosition: { row: number; column: number };

    /** The entry's end position in the document */
    endPosition: { row: number; column: number };

    /** Reference to the original AST node (for additional metadata if needed) */
    reference?: AstNode;
}

/**
 * Compare two Entry objects for equality.
 * Two entries are equal if they have the same kindId and text.
 * This mirrors the PartialEq implementation in Rust.
 */
function entryEquals(a: Entry, b: Entry): boolean {
    return a.kindId === b.kindId && a.text === b.text;
}

const treeSitterProcessor = new TreeSitterProcessor()


interface DiffResult {
    operation: 'insert' | 'delete' | 'equal';
    node: AstNode;
    sourceFile: 'A' | 'B';
}




/**
 * Negative index vector - allows indexing with negative numbers
 * Ported from Rust NegIdxVec
 */
class NegIdxVec {
    private data: number[];
    private offset: number;

    constructor(size: number) {
        this.data = new Array(size).fill(0);
        this.offset = Math.floor(size / 2);
    }

    get(k: number): number {
        return this.data[k + this.offset];
    }

    set(k: number, value: number): void {
        this.data[k + this.offset] = value;
    }
}

/**
 * Frontiers for the Myers diff algorithm
 * Stores the longest paths from both directions
 */
interface MyersFrontiers {
    forward: NegIdxVec;
    reverse: NegIdxVec;
}

/**
 * Create frontiers for the given input sizes
 */
function createFrontiers(oldLen: number, newLen: number): MyersFrontiers {
    const midpoint = Math.ceil((oldLen + newLen) / 2.0) + 1;
    const vecLength = midpoint * 2;
    return {
        forward: new NegIdxVec(vecLength),
        reverse: new NegIdxVec(vecLength),
    };
}

/**
 * Find the length of the common prefix between two arrays within the specified ranges
 */
function commonPrefixLen<T>(
    a: T[],
    aStart: number,
    aEnd: number,
    b: T[],
    bStart: number,
    bEnd: number,
    equals: (x: T, y: T) => boolean
): number {
    let len = 0;
    while (aStart + len < aEnd && bStart + len < bEnd && equals(a[aStart + len], b[bStart + len])) {
        len++;
    }
    return len;
}

/**
 * Find the length of the common suffix between two arrays within the specified ranges
 */
function commonSuffixLen<T>(
    a: T[],
    aStart: number,
    aEnd: number,
    b: T[],
    bStart: number,
    bEnd: number,
    equals: (x: T, y: T) => boolean
): number {
    let len = 1;
    while (aEnd - len >= aStart && bEnd - len >= bStart && equals(a[aEnd - len], b[bEnd - len])) {
        len++;
    }
    return len - 1;
}

/**
 * Coordinates for the middle snake
 */
interface Coordinates {
    old: number;
    new: number;
}

/**
 * Calculate the (x, y) coordinates of the midpoint of the optimal path.
 * This implementation derives from "An O(ND) Difference Algorithm and Its Variations" by Myers.
 */
function middleSnake<T>(
    old: T[],
    oldStart: number,
    oldEnd: number,
    newArr: T[],
    newStart: number,
    newEnd: number,
    frontiers: MyersFrontiers,
    equals: (x: T, y: T) => boolean
): Coordinates {
    const n = oldEnd - oldStart;
    const m = newEnd - newStart;
    const delta = n - m;
    const isOdd = delta % 2 !== 0;
    const midpoint = Math.ceil((m + n) / 2.0) + 1;

    const fwdFront = frontiers.forward;
    const revFront = frontiers.reverse;

    fwdFront.set(1, 0);
    revFront.set(1, 0);

    for (let d = 0; d <= midpoint; d++) {
        // Find the end of the furthest reaching forward d-path
        for (let k = -d; k <= d; k += 2) {
            // Choose whether to go down or right based on which diagonal has the highest x value
            let x: number;
            if (k === -d || (k !== d && fwdFront.get(k + 1) >= fwdFront.get(k - 1))) {
                // Longest diagonal is from the vertically connected d - 1 path
                x = fwdFront.get(k + 1);
            } else {
                // Longest diagonal is from the horizontally connected d - 1 path
                x = fwdFront.get(k - 1) + 1;
            }
            let y = x - k;

            // Coordinates of the first point in the snake
            const x0 = x;
            const y0 = y;

            // Extend the snake along the diagonal
            if (x < n && y < m) {
                const commonPref = commonPrefixLen(
                    old, oldStart + x, oldEnd,
                    newArr, newStart + y, newEnd,
                    equals
                );
                x += commonPref;
            }

            fwdFront.set(k, x);

            // If delta is odd and k is in the defined range, check for overlap
            if (isOdd && Math.abs(k - delta) < d) {
                const reverseX = revFront.get(-(k - delta));

                if (x + reverseX >= n) {
                    return {
                        old: oldStart + x0,
                        new: newStart + y0,
                    };
                }
            }
        }

        // Find the end of the furthest reaching reverse d-path
        for (let k = -d; k <= d; k += 2) {
            // Choose based on which diagonal has the largest x value in reverse
            let x: number;
            if (k === -d || (k !== d && revFront.get(k + 1) >= revFront.get(k - 1))) {
                x = revFront.get(k + 1);
            } else {
                x = revFront.get(k - 1) + 1;
            }
            let y = x - k;

            // Advance the diagonal as far as possible using suffix matching
            if (x < n && y < m) {
                const commonSuf = commonSuffixLen(
                    old, oldStart, oldStart + n - x,
                    newArr, newStart, newStart + m - y,
                    equals
                );
                x += commonSuf;
                y += commonSuf;
            }

            revFront.set(k, x);

            // If delta is even and k is in the defined range, check for overlap
            if (!isOdd && Math.abs(k - delta) <= d) {
                const forwardX = fwdFront.get(-(k - delta));

                if (forwardX + x >= n) {
                    return {
                        old: n - x + oldStart,
                        new: m - y + newStart,
                    };
                }
            }
        }
    }

    // Should be unreachable for valid inputs
    throw new Error('Middle snake not found - this should not happen');
}

/**
 * Edit type enum for diff results
 */
export type EditType<T> = { type: 'addition'; value: T } | { type: 'deletion'; value: T };

/**
 * Recursive implementation of Myers diff using divide-and-conquer
 */
function myersDiffImpl<T>(
    result: EditType<T>[],
    old: T[],
    oldStart: number,
    oldEnd: number,
    newArr: T[],
    newStart: number,
    newEnd: number,
    frontiers: MyersFrontiers,
    equals: (x: T, y: T) => boolean
): void {
    // Initial optimizations: skip common prefix + suffix
    const commonPref = commonPrefixLen(old, oldStart, oldEnd, newArr, newStart, newEnd, equals);
    oldStart += commonPref;
    newStart += commonPref;

    const commonSuf = commonSuffixLen(old, oldStart, oldEnd, newArr, newStart, newEnd, equals);
    // Make sure begin/end ranges don't overlap
    oldEnd = Math.max(oldStart, oldEnd - commonSuf);
    newEnd = Math.max(newStart, newEnd - commonSuf);

    // Base cases: if either or both inputs are empty
    if (oldStart >= oldEnd && newStart >= newEnd) {
        return;
    }

    if (oldStart >= oldEnd) {
        // All remaining elements in new are additions
        for (let i = newStart; i < newEnd; i++) {
            result.push({ type: 'addition', value: newArr[i] });
        }
        return;
    }

    if (newStart >= newEnd) {
        // All remaining elements in old are deletions
        for (let i = oldStart; i < oldEnd; i++) {
            result.push({ type: 'deletion', value: old[i] });
        }
        return;
    }

    // Find the middle snake
    const { old: xSplit, new: ySplit } = middleSnake(
        old, oldStart, oldEnd,
        newArr, newStart, newEnd,
        frontiers,
        equals
    );

    // Divide and conquer along the middle snake
    myersDiffImpl(result, old, oldStart, xSplit, newArr, newStart, ySplit, frontiers, equals);
    myersDiffImpl(result, old, xSplit, oldEnd, newArr, ySplit, newEnd, frontiers, equals);
}

/**
 * Myers difference algorithm implementation (linear space, divide-and-conquer)
 * Ported from Rust diff.rs
 * Returns the shortest edit script to transform array A into array B
 */
function myersDiff<T>(a: T[], b: T[], equals: (x: T, y: T) => boolean): { op: 'insert' | 'delete' | 'equal'; value: T; index: number }[] {
    // Use the optimized linear-space implementation
    const editTypes: EditType<T>[] = [];
    const frontiers = createFrontiers(a.length, b.length);
    myersDiffImpl(editTypes, a, 0, a.length, b, 0, b.length, frontiers, equals);

    // Convert EditType format to the expected output format
    const result: { op: 'insert' | 'delete' | 'equal'; value: T; index: number }[] = [];

    // We need to reconstruct the full sequence including equals for the existing API
    // Track positions in both arrays
    let aIdx = 0;
    let bIdx = 0;

    for (const edit of editTypes) {
        if (edit.type === 'deletion') {
            result.push({ op: 'delete', value: edit.value, index: aIdx });
            aIdx++;
        } else if (edit.type === 'addition') {
            result.push({ op: 'insert', value: edit.value, index: bIdx });
            bIdx++;
        }
    }

    return result;
}

/**
 * Parse source code and return the root node
 */
function parseSource(sourceCode: string): Parser.SyntaxNode {
    const parser = new Parser();
    parser.setLanguage(JavaScript);

    const chunkSize = 1024;
    const tree = parser.parse((index: number) => {
        return sourceCode.slice(index, index + chunkSize);
    });

    return tree.rootNode;
}

/**
 * Compare two JavaScript files and return the differences
 * Uses Entry abstraction for comparison, mirroring the Rust implementation
 */
export function diffAst(sourceA: string, sourceB: string, depth = 2, includeText = true): DiffResult[] {
    const rootA = parseSource(sourceA);
    const rootB = parseSource(sourceB);

    // Convert AstNodes to Entries for comparison (mirrors Rust's process_vec_data)
    const entriesA = treeSitterProcessor.process(rootA.tree,sourceA,"JavaScript")
    const entriesB = treeSitterProcessor.process(rootB.tree,sourceB,"JavaScript")



    // Use Entry-based comparison (mirrors Rust's Entry::eq)
    const diffs = myersDiff(entriesA, entriesB, entryEquals);

    const results: DiffResult[] = [];
    for (const diff of diffs) {
        if (diff.op !== 'equal') {
            // Extract the original AstNode from the Entry's reference
            // todo have to create hunk like original rust
            const node = {
                type: diff.value.kindId,
                text: diff.value.text,
                startPosition: diff.value.startPosition,
                endPosition: diff.value.endPosition,
            };
            results.push({
                operation: diff.op,
                node: node,
                sourceFile: diff.op === 'delete' ? 'A' : 'B'
            });
        }
    }

    return results;
}
function printEntry(entry:DiffResult) {
    console.log(`${entry.operation} kind(${entry.node.type}) ${entry.node.text}`)
}
/**
 * Print diff results in a readable format
 */
function printDiffResults(results: DiffResult[]): void {
    if (results.length === 0) {
        console.log('No differences found between the two files.');
        return;
    }

    console.log(`Found ${results.length} difference(s):\n`);

    for (let i = 0; i < results.length; i++) {
        const diff = results[i];
        const prefix = diff.operation === 'delete' ? '- [DELETE]' : '+ [INSERT]';
        const color = diff.operation === 'delete' ? '\x1b[31m' : '\x1b[32m';
        const reset = '\x1b[0m';

        console.log(`${color}${prefix} (File ${diff.sourceFile})${reset}`);
        console.log(printEntry(diff));
        console.log('');
    }
}
const TEST_TREE_SITTER_PROCESSOR = false

// Main: Read two filepaths from arguments and compare
const filePathA = process.argv[2];
const filePathB = process.argv[3];
const depth = parseInt(process.argv[4] || '2', 10);

if (!filePathA || !filePathB) {
    console.error('Usage: npx ts-node src/diffAst.ts <fileA> <fileB> [depth]');
    console.error('  fileA, fileB: JavaScript files to compare');
    console.error('  depth: How deep to traverse the AST (default: 2)');
    process.exit(1);
}

const contentA = fs.readFileSync(filePathA, 'utf-8');
const contentB = fs.readFileSync(filePathB, 'utf-8');

if (TEST_TREE_SITTER_PROCESSOR) {
    const rootA = parseSource(contentA);
    const entries = treeSitterProcessor.process(rootA.tree,contentA,"JavaScript")
    entries.forEach(entry => console.log(`kind(${entry.kindId}) ${entry.text}`))
}
else {
    const differences = diffAst(contentA, contentB, depth);
    printDiffResults(differences);
}