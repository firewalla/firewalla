import { Collection } from '../nodes/Collection.js';
import { StringifyContext } from './stringify.js';
declare type StringifyNode = {
    comment: boolean;
    str: string;
};
interface StringifyCollectionOptions {
    blockItem(node: StringifyNode): string;
    flowChars: {
        start: '{';
        end: '}';
    } | {
        start: '[';
        end: ']';
    };
    itemIndent: string;
    onChompKeep?: () => void;
    onComment?: () => void;
}
export declare function stringifyCollection({ comment, flow, items }: Readonly<Collection>, ctx: StringifyContext, { blockItem, flowChars, itemIndent, onChompKeep, onComment }: StringifyCollectionOptions): string;
export {};
