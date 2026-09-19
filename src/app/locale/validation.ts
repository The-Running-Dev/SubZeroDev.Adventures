export const validationEn: Record<string, string> = {
  invalid_identifier:
    "Campaign id must be lower-case words joined by hyphens{{where}}.",
  missing_string_key: "Some text is still blank{{where}}.",
  dangling_reference: "A choice leads to a scene that does not exist{{where}}.",
  duplicate_id: "Two things share the id{{where}}.",
  missing_label_key: "A visible stat needs a label{{where}}.",
  non_visible_variable_in_text:
    "Scene text uses a stat that is not marked visible{{where}}.",
  undeclared_variable:
    "An effect writes to a stat that is not declared{{where}}.",
  invalid_consequence_value:
    "An effect's value does not match its stat's type{{where}}.",
  unreachable_node: "Nothing leads to this scene{{where}}.",
  no_reachable_choice:
    "No scene with choices can be reached from the opening{{where}}.",
  no_reachable_ending: "No ending can be reached from the opening{{where}}.",
  unreachable_cycle: "This scene loops with no way out{{where}}.",
  invalid_loc_key: "Malformed text key{{where}}.",
  unnamed_campaign:
    "Name the campaign — until it has an id, the text keys it defines have nothing to prefix them{{where}}.",
  unknown: "{{code}}{{where}}",
};
export const validationBg = {
  invalid_identifier:
    "Идентификаторът на кампанията трябва да е с малки латински букви и тирета{{where}}.",
  invalid_loc_key: "Невалиден текстов ключ{{where}}.",
  unnamed_campaign:
    "Дай име на кампанията — без идентификатор текстовите ключове нямат префикс{{where}}.",
  missing_string_key: "Все още има празен текст{{where}}.",
  dangling_reference: "Изборът води към несъществуваща сцена{{where}}.",
  duplicate_id: "Два елемента използват един идентификатор{{where}}.",
  missing_label_key: "Видимият показател се нуждае от етикет{{where}}.",
  non_visible_variable_in_text:
    "Текстът използва показател, който не е видим{{where}}.",
  undeclared_variable: "Ефектът променя недеклариран показател{{where}}.",
  invalid_consequence_value:
    "Стойността на ефекта не съответства на типа на показателя{{where}}.",
  unreachable_node: "Нищо не води към тази сцена{{where}}.",
  no_reachable_choice:
    "От началото не може да се достигне сцена с избори{{where}}.",
  no_reachable_ending: "От началото не може да се достигне финал{{where}}.",
  unreachable_cycle: "Сцената образува цикъл без изход{{where}}.",
  unknown: "Код на проверката: {{code}}{{where}}",
};
