declare function flatten <T> (array: flatten.NestedArray<T>): T[];

declare namespace flatten {
  interface NestedArray <T> {
    [index: number]: T | NestedArray<T>;
    length: number;
  }

  export function from <T> (array: NestedArray<T>): T[];
  export function depth <T> (array: NestedArray<T>, depth: number): NestedArray<T>;
  export function depthFrom <T> (array: NestedArray<T>, depth: number): NestedArray<T>;
}

export = flatten;
