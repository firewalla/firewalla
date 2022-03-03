import { MAP, SCALAR, SEQ } from '../nodes/Node.js';
import type { Pair } from '../nodes/Pair.js';
import type { SchemaOptions } from '../options.js';
import type { CollectionTag, ScalarTag } from './types.js';
export declare type SchemaName = 'core' | 'failsafe' | 'json' | 'yaml-1.1';
export declare class Schema {
    knownTags: Record<string, CollectionTag | ScalarTag>;
    merge: boolean;
    name: SchemaName;
    sortMapEntries: ((a: Pair, b: Pair) => number) | null;
    tags: Array<CollectionTag | ScalarTag>;
    [MAP]: CollectionTag;
    [SCALAR]: ScalarTag;
    [SEQ]: CollectionTag;
    constructor({ customTags, merge, resolveKnownTags, schema, sortMapEntries }: SchemaOptions);
    clone(): Schema;
}
