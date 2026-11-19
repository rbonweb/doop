/** The Design tab's Variants group on a main: authoring enum and boolean variants, previewing a combination, and styling it. */
export const componentVariants = {
  heading: 'Variants',
  empty: 'No variants yet. Add one to give this component more than one look.',
  addVariant: 'Add variant',
  addChoice: 'Choice (sm, md, lg)',
  addBoolean: 'On or off',
  nameLabel: 'Variant name',
  namePlaceholder: 'e.g. size',
  valuesLabel: 'Values',
  valuesPlaceholder: 'sm, md, lg',
  add: 'Add',
  save: 'Save',
  booleanTag: 'on / off',
  defaultTag: 'default',

  propMenuAria: 'Actions for the {prop} variant',
  renameProp: 'Rename variant',
  removeProp: 'Remove variant',
  addValue: 'Add value',
  addValueAria: 'Add a value to {prop}',
  newValuePlaceholder: 'New value',
  newValueAria: 'New value for {prop}',
  valueAria: '{prop}: {value}',
  makeDefault: 'Make default',
  renameValue: 'Rename',
  removeValue: 'Remove',
  renameValueAria: 'Rename {value}',
  renamePropAria: 'Rename {prop}',

  removeValueTitle: 'Remove “{value}” from {prop}?',
  removePropTitle: 'Remove the {prop} variant?',
  instancesUse: {
    one: '{count} instance uses it and goes back to the default.',
    other: '{count} instances use it and go back to the default.',
  },
  instancesUseProp: {
    one: '{count} instance sets it and loses that choice.',
    other: '{count} instances set it and lose that choice.',
  },
  noInstancesUse: 'No instance uses it.',
  removeGoesWith: 'Its style rules are removed with it. The editor cannot undo this.',
  newDefaultLabel: 'New default',
  confirmRemove: 'Remove',

  previewHeading: 'Preview variant',
  previewHint: 'Shows a combination on the main. Nothing is saved.',
  previewAria: 'Preview {prop}',
  editing: 'Editing {combination}',
  editingHint:
    'Style changes in this panel and resizing now apply to this combination only, and {undo} cannot undo them. Moving, turning, grouping and aligning are off until you go back to the base.',
  backToBase: 'Back to base',
  styledProperties: {
    one: '{count} property styled for this combination.',
    other: '{count} properties styled for this combination.',
  },

  failed: 'The variants could not be changed.',
  styleFailed: 'The variant style could not be saved.',
  refused:
    'A variant is being previewed: go back to the base to do this. Here it would change the component itself and every instance.',
  noPart: 'This layer has no key to style per variant. Go back to the base to edit it.',
} as const
