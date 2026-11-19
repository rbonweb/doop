/** The Design tab's editors for an instance's list props and rich-text props. */
export const componentFields = {
  /* lists */
  listAria: '{name} list',
  listEmpty: 'No items yet.',
  addItem: 'Add item',
  itemTitle: 'Item {n}',
  itemTitleNamed: '{n}. {name}',
  itemMenuAria: 'Actions for item {n}',
  dragItemAria: 'Drag to reorder item {n}',
  moveUp: 'Move up',
  moveDown: 'Move down',
  duplicateItem: 'Duplicate',
  removeItem: 'Remove',
  fieldImageAria: '{field}, item {n}',
  listFull: 'A list holds at most {max} items.',
  /* rich text */
  richAria: '{name}, rich text',
  bold: 'Bold',
  italic: 'Italic',
  link: 'Link',
  removeLink: 'Remove link',
  linkPlaceholder: 'https://…',
  linkAria: 'Link address',
  applyLink: 'Apply',
  linkInvalid: 'Use a full web address starting with http:// or https://.',
  linkNeedsSelection: 'Select some text first, then add a link.',
} as const
