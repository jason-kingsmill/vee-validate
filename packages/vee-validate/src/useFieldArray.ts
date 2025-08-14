import { Ref, unref, ref, onBeforeUnmount, watch, MaybeRefOrGetter, toValue } from 'vue';
import { klona as deepCopy } from 'klona/full';
import { isNullOrUndefined } from '../../shared';
import { FormContextKey } from './symbols';
import { FieldArrayContext, FieldEntry, PrivateFieldArrayContext, PrivateFormContext } from './types';
import { computedDeep, getFromPath, injectWithSelf, warn, isEqual, setInPath } from './utils';

export function useFieldArray<TValue = unknown>(arrayPath: MaybeRefOrGetter<string>): FieldArrayContext<TValue> {
  const form = injectWithSelf(FormContextKey, undefined) as PrivateFormContext;
  const fields: Ref<FieldEntry<TValue>[]> = ref([]);

  const noOp = () => {};
  const noOpApi: FieldArrayContext<TValue> = {
    fields,
    remove: noOp,
    push: noOp,
    swap: noOp,
    insert: noOp,
    update: noOp,
    replace: noOp,
    prepend: noOp,
    move: noOp,
  };

  if (!form) {
    if (__DEV__) {
      warn(
        'FieldArray requires being a child of `<Form/>` or `useForm` being called before it. Array fields may not work correctly',
      );
    }

    return noOpApi;
  }

  if (!unref(arrayPath)) {
    if (__DEV__) {
      warn('FieldArray requires a field path to be provided, did you forget to pass the `name` prop?');
    }
    return noOpApi;
  }

  const alreadyExists = form.fieldArrays.find(a => unref(a.path) === unref(arrayPath));
  if (alreadyExists) {
    return alreadyExists as PrivateFieldArrayContext<TValue>;
  }

  let entryCounter = 0;

  function getCurrentValues() {
    return getFromPath<TValue[]>(form?.values, toValue(arrayPath), []) || [];
  }

  function initFields() {
    const currentValues = getCurrentValues();
    if (!Array.isArray(currentValues)) {
      return;
    }

    fields.value = currentValues.map((v, idx) => createEntry(v, idx, fields.value));
    updateEntryFlags();
  }

  initFields();

  function updateEntryFlags() {
    const fieldsLength = fields.value.length;
    for (let i = 0; i < fieldsLength; i++) {
      const entry = fields.value[i];
      entry.isFirst = i === 0;
      entry.isLast = i === fieldsLength - 1;
    }
  }

  function createEntry(value: TValue, idx?: number, currentFields?: FieldEntry<TValue>[]): FieldEntry<TValue> {
    // Skips the work by returning the current entry if it already exists
    // This should make the `key` prop stable and doesn't cause more re-renders than needed
    // The value is computed and should update anyways
    if (currentFields && !isNullOrUndefined(idx) && currentFields[idx]) {
      return currentFields[idx];
    }

    const key = entryCounter++;
    const entry: FieldEntry<TValue> = {
      key,
      value: computedDeep<TValue>({
        get() {
          const currentValues = getFromPath<TValue[]>(form?.values, toValue(arrayPath), []) || [];
          const idx = fields.value.findIndex(e => e.key === key);

          return idx === -1 ? value : currentValues[idx];
        },
        set(value: TValue) {
          const idx = fields.value.findIndex(e => e.key === key);
          if (idx === -1) {
            if (__DEV__) {
              warn(`Attempting to update a non-existent array item`);
            }
            return;
          }

          update(idx, value);
        },
      }) as TValue, // will be auto unwrapped
      isFirst: false,
      isLast: false,
    };

    return entry;
  }

  function afterMutation() {
    updateEntryFlags();
    // Should trigger a silent validation since a field may not do that #4096
    form?.validate({ mode: 'silent' });
  }

  function remove(idx: number) {
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    if (!pathValue || !Array.isArray(pathValue) || idx < 0 || idx >= pathValue.length) {
      return;
    }

    // Snapshot the previous array before mutation
    const prevArray = [...pathValue];
    const newValue = [...pathValue];
    newValue.splice(idx, 1);
    const fieldPath = pathName + `[${idx}]`;
    form.destroyPath(fieldPath);
    form.unsetInitialValue(fieldPath);
    setInPath(form.values, pathName, newValue);
    fields.value.splice(idx, 1);
    // All indices from idx to end shift
    const affected = Array.from({ length: prevArray.length - idx }, (_, k) => idx + k);
    form.notifyValuesChanged(
      affected.map(i => ({ path: `${pathName}[${i}]`, oldValue: prevArray?.[i], newValue: newValue[i] })),
    );

    afterMutation();
  }

  function push(initialValue: TValue) {
    const value = deepCopy(initialValue);
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    const normalizedPathValue = isNullOrUndefined(pathValue) ? [] : pathValue;
    if (!Array.isArray(normalizedPathValue)) {
      return;
    }

    const newValue = [...normalizedPathValue];
    newValue.push(value);
    form.stageInitialValue(pathName + `[${newValue.length - 1}]`, value);
    setInPath(form.values, pathName, newValue);
    fields.value.push(createEntry(value));
    form.notifyValuesChanged({ path: `${pathName}[${newValue.length - 1}]`, oldValue: undefined, newValue: value });
    afterMutation();
  }

  function swap(indexA: number, indexB: number) {
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    if (!Array.isArray(pathValue) || !(indexA in pathValue) || !(indexB in pathValue)) {
      return;
    }

    const newValue = [...pathValue];
    const newFields = [...fields.value];

    // the old switcheroo
    const temp = newValue[indexA];
    newValue[indexA] = newValue[indexB];
    newValue[indexB] = temp;

    const tempEntry = newFields[indexA];
    newFields[indexA] = newFields[indexB];
    newFields[indexB] = tempEntry;
    const prev = getFromPath(form.values, pathName) as TValue[] | undefined;
    setInPath(form.values, pathName, newValue);
    fields.value = newFields;
    updateEntryFlags();
    form.notifyValuesChanged([
      { path: `${pathName}[${indexA}]`, oldValue: prev?.[indexA], newValue: newValue[indexA] },
      { path: `${pathName}[${indexB}]`, oldValue: prev?.[indexB], newValue: newValue[indexB] },
    ]);
  }

  function insert(idx: number, initialValue: TValue) {
    const value = deepCopy(initialValue);
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    if (!Array.isArray(pathValue) || pathValue.length < idx) {
      return;
    }

    const newValue = [...pathValue];
    const newFields = [...fields.value];

    newValue.splice(idx, 0, value);
    newFields.splice(idx, 0, createEntry(value));
    const prev = getFromPath(form.values, pathName) as TValue[] | undefined;
    setInPath(form.values, pathName, newValue);
    fields.value = newFields;
    // All indices from idx to end shift
    const affected = Array.from({ length: newValue.length - idx }, (_, k) => idx + k);
    form.notifyValuesChanged(
      affected.map(i => ({ path: `${pathName}[${i}]`, oldValue: prev?.[i], newValue: newValue[i] })),
    );
    afterMutation();
  }

  function replace(arr: TValue[]) {
    const pathName = toValue(arrayPath);
    form.stageInitialValue(pathName, arr);
    const prev = getFromPath(form.values, pathName) as TValue[] | undefined;
    setInPath(form.values, pathName, arr);
    initFields();
    const affected = Array.from({ length: Array.isArray(arr) ? arr.length : 0 }, (_, k) => k);
    form.notifyValuesChanged(affected.map(i => ({ path: `${pathName}[${i}]`, oldValue: prev?.[i], newValue: arr[i] })));
    afterMutation();
  }

  function update(idx: number, value: TValue) {
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    if (!Array.isArray(pathValue) || pathValue.length - 1 < idx) {
      return;
    }

    const prev = getFromPath(form.values, `${pathName}[${idx}]`);
    setInPath(form.values, `${pathName}[${idx}]`, value);
    form?.validate({ mode: 'validated-only' });
    if (!isEqual(prev, value)) {
      form.notifyValuesChanged({ path: `${pathName}[${idx}]`, oldValue: prev, newValue: value });
    }
  }

  function prepend(initialValue: TValue) {
    const value = deepCopy(initialValue);
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    const normalizedPathValue = isNullOrUndefined(pathValue) ? [] : pathValue;
    if (!Array.isArray(normalizedPathValue)) {
      return;
    }

    const newValue = [value, ...normalizedPathValue];
    const prev = getFromPath(form.values, pathName) as TValue[] | undefined;
    setInPath(form.values, pathName, newValue);
    form.stageInitialValue(pathName + `[0]`, value);
    fields.value.unshift(createEntry(value));
    // All indices shift
    const affected = Array.from({ length: newValue.length }, (_, k) => `${pathName}[${k}]`).filter(p => {
      const i = Number(p.match(/\[(\d+)\]$/)?.[1] || 0);
      const before = prev?.[i];
      const after = newValue[i];
      return !isEqual(before, after);
    });
    form.notifyValuesChanged(
      affected.map(p => {
        const i = Number(p.match(/\[(\d+)\]$/)?.[1] || 0);
        return { path: p, oldValue: prev?.[i], newValue: newValue[i] };
      }),
    );
    afterMutation();
  }

  function move(oldIdx: number, newIdx: number) {
    const pathName = toValue(arrayPath);
    const pathValue = getFromPath<TValue[]>(form?.values, pathName);
    const newValue = isNullOrUndefined(pathValue) ? [] : [...pathValue];

    if (!Array.isArray(pathValue) || !(oldIdx in pathValue) || !(newIdx in pathValue)) {
      return;
    }

    const newFields = [...fields.value];

    const movedItem = newFields[oldIdx];
    newFields.splice(oldIdx, 1);
    newFields.splice(newIdx, 0, movedItem);

    const movedValue = newValue[oldIdx];
    newValue.splice(oldIdx, 1);
    newValue.splice(newIdx, 0, movedValue);
    const prev = getFromPath(form.values, pathName) as TValue[] | undefined;
    setInPath(form.values, pathName, newValue);
    fields.value = newFields;
    // Affected indices are the range between old and new positions (inclusive)
    const start = Math.min(oldIdx, newIdx);
    const end = Math.max(oldIdx, newIdx);
    const affected = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    form.notifyValuesChanged(
      affected.map(i => ({ path: `${pathName}[${i}]`, oldValue: prev?.[i], newValue: newValue[i] })),
    );
    afterMutation();
  }

  const fieldArrayCtx: FieldArrayContext<TValue> = {
    fields,
    remove,
    push,
    swap,
    insert,
    update,
    replace,
    prepend,
    move,
  };

  form.fieldArrays.push({
    path: arrayPath,
    reset: initFields,
    ...fieldArrayCtx,
  });

  onBeforeUnmount(() => {
    const idx = form.fieldArrays.findIndex(i => toValue(i.path) === toValue(arrayPath));
    if (idx >= 0) {
      form.fieldArrays.splice(idx, 1);
    }
  });

  // Makes sure to sync the form values with the array value if they go out of sync
  // #4153
  watch(getCurrentValues, formValues => {
    const fieldsValues = fields.value.map(f => f.value);
    // If form values are not the same as the current values then something overrode them.
    if (!isEqual(formValues, fieldsValues)) {
      initFields();
    }
  });

  return fieldArrayCtx;
}
