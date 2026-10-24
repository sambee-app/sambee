export function requireTestValue<Value>(value: Value | null | undefined): Value {
  if (value === null || value === undefined) {
    throw new Error("Expected a test fixture or result to be present");
  }
  return value;
}

export function uninitializedTestCallback(): never {
  throw new Error("Test callback invoked before initialization");
}

export function requireTestElement<ElementType extends Element>(
  value: Element | null | undefined,
  elementType: new () => ElementType
): ElementType {
  if (!(value instanceof elementType)) {
    throw new Error(`Expected a ${elementType.name} test element`);
  }
  return value;
}
