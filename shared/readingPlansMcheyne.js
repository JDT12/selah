// Robert Murray M'Cheyne's Calendar for Daily Readings (1842, public domain): four readings a day, two "family" and two
// "secret". One line per day from January 1 (no February 29), the readings separated by semicolons, taken from a
// published copy of the calendar.
const TABLE = `
Genesis 1;Matthew 1;Ezra 1;Acts 1
Genesis 2;Matthew 2;Ezra 2;Acts 2
Genesis 3;Matthew 3;Ezra 3;Acts 3
Genesis 4;Matthew 4;Ezra 4;Acts 4
Genesis 5;Matthew 5;Ezra 5;Acts 5
Genesis 6;Matthew 6;Ezra 6;Acts 6
Genesis 7;Matthew 7;Ezra 7;Acts 7
Genesis 8;Matthew 8;Ezra 8;Acts 8
Genesis 9-10;Matthew 9;Ezra 9;Acts 9
Genesis 11;Matthew 10;Ezra 10;Acts 10
Genesis 12;Matthew 11;Nehemiah 1;Acts 11
Genesis 13;Matthew 12;Nehemiah 2;Acts 12
Genesis 14;Matthew 13;Nehemiah 3;Acts 13
Genesis 15;Matthew 14;Nehemiah 4;Acts 14
Genesis 16;Matthew 15;Nehemiah 5;Acts 15
Genesis 17;Matthew 16;Nehemiah 6;Acts 16
Genesis 18;Matthew 17;Nehemiah 7;Acts 17
Genesis 19;Matthew 18;Nehemiah 8;Acts 18
Genesis 20;Matthew 19;Nehemiah 9;Acts 19
Genesis 21;Matthew 20;Nehemiah 10;Acts 20
Genesis 22;Matthew 21;Nehemiah 11;Acts 21
Genesis 23;Matthew 22;Nehemiah 12;Acts 22
Genesis 24;Matthew 23;Nehemiah 13;Acts 23
Genesis 25;Matthew 24;Esther 1;Acts 24
Genesis 26;Matthew 25;Esther 2;Acts 25
Genesis 27;Matthew 26;Esther 3;Acts 26
Genesis 28;Matthew 27;Esther 4;Acts 27
Genesis 29;Matthew 28;Esther 5;Acts 28
Genesis 30;Mark 1;Esther 6;Romans 1
Genesis 31;Mark 2;Esther 7;Romans 2
Genesis 32;Mark 3;Esther 8;Romans 3
Genesis 33;Mark 4;Esther 9-10;Romans 4
Genesis 34;Mark 5;Job 1;Romans 5
Genesis 35-36;Mark 6;Job 2;Romans 6
Genesis 37;Mark 7;Job 3;Romans 7
Genesis 38;Mark 8;Job 4;Romans 8
Genesis 39;Mark 9;Job 5;Romans 9
Genesis 40;Mark 10;Job 6;Romans 10
Genesis 41;Mark 11;Job 7;Romans 11
Genesis 42;Mark 12;Job 8;Romans 12
Genesis 43;Mark 13;Job 9;Romans 13
Genesis 44;Mark 14;Job 10;Romans 14
Genesis 45;Mark 15;Job 11;Romans 15
Genesis 46;Mark 16;Job 12;Romans 16
Genesis 47;Luke 1:1-38;Job 13;1 Corinthians 1
Genesis 48;Luke 1:39-80;Job 14;1 Corinthians 2
Genesis 49;Luke 2;Job 15;1 Corinthians 3
Genesis 50;Luke 3;Job 16-17;1 Corinthians 4
Exodus 1;Luke 4;Job 18;1 Corinthians 5
Exodus 2;Luke 5;Job 19;1 Corinthians 6
Exodus 3;Luke 6;Job 20;1 Corinthians 7
Exodus 4;Luke 7;Job 21;1 Corinthians 8
Exodus 5;Luke 8;Job 22;1 Corinthians 9
Exodus 6;Luke 9;Job 23;1 Corinthians 10
Exodus 7;Luke 10;Job 24;1 Corinthians 11
Exodus 8;Luke 11;Job 25-26;1 Corinthians 12
Exodus 9;Luke 12;Job 27;1 Corinthians 13
Exodus 10;Luke 13;Job 28;1 Corinthians 14
Exodus 11;Luke 14;Job 29;1 Corinthians 15
Exodus 12;Luke 15;Job 30;1 Corinthians 16
Exodus 13;Luke 16;Job 31;2 Corinthians 1
Exodus 14;Luke 17;Job 32;2 Corinthians 2
Exodus 15;Luke 18;Job 33;2 Corinthians 3
Exodus 16;Luke 19;Job 34;2 Corinthians 4
Exodus 17;Luke 20;Job 35;2 Corinthians 5
Exodus 18;Luke 21;Job 36;2 Corinthians 6
Exodus 19;Luke 22;Job 37;2 Corinthians 7
Exodus 20;Luke 23;Job 38;2 Corinthians 8
Exodus 21;Luke 24;Job 39;2 Corinthians 9
Exodus 22;John 1;Job 40;2 Corinthians 10
Exodus 23;John 2;Job 41;2 Corinthians 11
Exodus 24;John 3;Job 42;2 Corinthians 12
Exodus 25;John 4;Proverbs 1;2 Corinthians 13
Exodus 26;John 5;Proverbs 2;Galatians 1
Exodus 27;John 6;Proverbs 3;Galatians 2
Exodus 28;John 7;Proverbs 4;Galatians 3
Exodus 29;John 8;Proverbs 5;Galatians 4
Exodus 30;John 9;Proverbs 6;Galatians 5
Exodus 31;John 10;Proverbs 7;Galatians 6
Exodus 32;John 11;Proverbs 8;Ephesians 1
Exodus 33;John 12;Proverbs 9;Ephesians 2
Exodus 34;John 13;Proverbs 10;Ephesians 3
Exodus 35;John 14;Proverbs 11;Ephesians 4
Exodus 36;John 15;Proverbs 12;Ephesians 5
Exodus 37;John 16;Proverbs 13;Ephesians 6
Exodus 38;John 17;Proverbs 14;Philippians 1
Exodus 39;John 18;Proverbs 15;Philippians 2
Exodus 40;John 19;Proverbs 16;Philippians 3
Leviticus 1;John 20;Proverbs 17;Philippians 4
Leviticus 2-3;John 21;Proverbs 18;Colossians 1
Leviticus 4;Psalm 1-2;Proverbs 19;Colossians 2
Leviticus 5;Psalm 3-4;Proverbs 20;Colossians 3
Leviticus 6;Psalm 5-6;Proverbs 21;Colossians 4
Leviticus 7;Psalm 7-8;Proverbs 22;1 Thessalonians 1
Leviticus 8;Psalm 9;Proverbs 23;1 Thessalonians 2
Leviticus 9;Psalm 10;Proverbs 24;1 Thessalonians 3
Leviticus 10;Psalm 11-12;Proverbs 25;1 Thessalonians 4
Leviticus 11-12;Psalm 13-14;Proverbs 26;1 Thessalonians 5
Leviticus 13;Psalm 15-16;Proverbs 27;2 Thessalonians 1
Leviticus 14;Psalm 17;Proverbs 28;2 Thessalonians 2
Leviticus 15;Psalm 18;Proverbs 29;2 Thessalonians 3
Leviticus 16;Psalm 19;Proverbs 30;1 Timothy 1
Leviticus 17;Psalm 20-21;Proverbs 31;1 Timothy 2
Leviticus 18;Psalm 22;Ecclesiastes 1;1 Timothy 3
Leviticus 19;Psalm 23-24;Ecclesiastes 2;1 Timothy 4
Leviticus 20;Psalm 25;Ecclesiastes 3;1 Timothy 5
Leviticus 21;Psalm 26-27;Ecclesiastes 4;1 Timothy 6
Leviticus 22;Psalm 28-29;Ecclesiastes 5;2 Timothy 1
Leviticus 23;Psalm 30;Ecclesiastes 6;2 Timothy 2
Leviticus 24;Psalm 31;Ecclesiastes 7;2 Timothy 3
Leviticus 25;Psalm 32;Ecclesiastes 8;2 Timothy 4
Leviticus 26;Psalm 33;Ecclesiastes 9;Titus 1
Leviticus 27;Psalm 34;Ecclesiastes 10;Titus 2
Numbers 1;Psalm 35;Ecclesiastes 11;Titus 3
Numbers 2;Psalm 36;Ecclesiastes 12;Philemon 1
Numbers 3;Psalm 37;Song of Solomon 1;Hebrews 1
Numbers 4;Psalm 38;Song of Solomon 2;Hebrews 2
Numbers 5;Psalm 39;Song of Solomon 3;Hebrews 3
Numbers 6;Psalm 40-41;Song of Solomon 4;Hebrews 4
Numbers 7;Psalm 42-43;Song of Solomon 5;Hebrews 5
Numbers 8;Psalm 44;Song of Solomon 6;Hebrews 6
Numbers 9;Psalm 45;Song of Solomon 7;Hebrews 7
Numbers 10;Psalm 46-47;Song of Solomon 8;Hebrews 8
Numbers 11;Psalm 48;Isaiah 1;Hebrews 9
Numbers 12-13;Psalm 49;Isaiah 2;Hebrews 10
Numbers 14;Psalm 50;Isaiah 3-4;Hebrews 11
Numbers 15;Psalm 51;Isaiah 5;Hebrews 12
Numbers 16;Psalm 52-54;Isaiah 6;Hebrews 13
Numbers 17-18;Psalm 55;Isaiah 7;James 1
Numbers 19;Psalm 56-57;Isaiah 8;James 2
Numbers 20;Psalm 58-59;Isaiah 9;James 3
Numbers 21;Psalm 60-61;Isaiah 10;James 4
Numbers 22;Psalm 62-63;Isaiah 11-12;James 5
Numbers 23;Psalm 64-65;Isaiah 13;1 Peter 1
Numbers 24;Psalm 66-67;Isaiah 14;1 Peter 2
Numbers 25;Psalm 68;Isaiah 15;1 Peter 3
Numbers 26;Psalm 69;Isaiah 16;1 Peter 4
Numbers 27;Psalm 70-71;Isaiah 17-18;1 Peter 5
Numbers 28;Psalm 72;Isaiah 19-20;2 Peter 1
Numbers 29;Psalm 73;Isaiah 21;2 Peter 2
Numbers 30;Psalm 74;Isaiah 22;2 Peter 3
Numbers 31;Psalm 75-76;Isaiah 23;1 John 1
Numbers 32;Psalm 77;Isaiah 24;1 John 2
Numbers 33;Psalm 78:1-39;Isaiah 25;1 John 3
Numbers 34;Psalm 78:40-72;Isaiah 26;1 John 4
Numbers 35;Psalm 79;Isaiah 27;1 John 5
Numbers 36;Psalm 80;Isaiah 28;2 John 1
Deuteronomy 1;Psalm 81-82;Isaiah 29;3 John 1
Deuteronomy 2;Psalm 83-84;Isaiah 30;Jude 1
Deuteronomy 3;Psalm 85;Isaiah 31;Revelation 1
Deuteronomy 4;Psalm 86-87;Isaiah 32;Revelation 2
Deuteronomy 5;Psalm 88;Isaiah 33;Revelation 3
Deuteronomy 6;Psalm 89;Isaiah 34;Revelation 4
Deuteronomy 7;Psalm 90;Isaiah 35;Revelation 5
Deuteronomy 8;Psalm 91;Isaiah 36;Revelation 6
Deuteronomy 9;Psalm 92-93;Isaiah 37;Revelation 7
Deuteronomy 10;Psalm 94;Isaiah 38;Revelation 8
Deuteronomy 11;Psalm 95-96;Isaiah 39;Revelation 9
Deuteronomy 12;Psalm 97-98;Isaiah 40;Revelation 10
Deuteronomy 13-14;Psalm 99-101;Isaiah 41;Revelation 11
Deuteronomy 15;Psalm 102;Isaiah 42;Revelation 12
Deuteronomy 16;Psalm 103;Isaiah 43;Revelation 13
Deuteronomy 17;Psalm 104;Isaiah 44;Revelation 14
Deuteronomy 18;Psalm 105;Isaiah 45;Revelation 15
Deuteronomy 19;Psalm 106;Isaiah 46;Revelation 16
Deuteronomy 20;Psalm 107;Isaiah 47;Revelation 17
Deuteronomy 21;Psalm 108-109;Isaiah 48;Revelation 18
Deuteronomy 22;Psalm 110-111;Isaiah 49;Revelation 19
Deuteronomy 23;Psalm 112-113;Isaiah 50;Revelation 20
Deuteronomy 24;Psalm 114-115;Isaiah 51;Revelation 21
Deuteronomy 25;Psalm 116;Isaiah 52;Revelation 22
Deuteronomy 26;Psalm 117-118;Isaiah 53;Matthew 1
Deuteronomy 27;Psalm 119:1-24;Isaiah 54;Matthew 2
Deuteronomy 28;Psalm 119:25-48;Isaiah 55;Matthew 3
Deuteronomy 29;Psalm 119:49-72;Isaiah 56;Matthew 4
Deuteronomy 30;Psalm 119:73-96;Isaiah 57;Matthew 5
Deuteronomy 31;Psalm 119:97-120;Isaiah 58;Matthew 6
Deuteronomy 32;Psalm 119:121-144;Isaiah 59;Matthew 7
Deuteronomy 33-34;Psalm 119:145-176;Isaiah 60;Matthew 8
Joshua 1;Psalm 120-122;Isaiah 61;Matthew 9
Joshua 2;Psalm 123-125;Isaiah 62;Matthew 10
Joshua 3;Psalm 126-128;Isaiah 63;Matthew 11
Joshua 4;Psalm 129-131;Isaiah 64;Matthew 12
Joshua 5;Psalm 132-134;Isaiah 65;Matthew 13
Joshua 6;Psalm 135-136;Isaiah 66;Matthew 14
Joshua 7;Psalm 137-138;Jeremiah 1;Matthew 15
Joshua 8;Psalm 139;Jeremiah 2;Matthew 16
Joshua 9;Psalm 140-141;Jeremiah 3;Matthew 17
Joshua 10;Psalm 142-143;Jeremiah 4;Matthew 18
Joshua 11;Psalm 144;Jeremiah 5;Matthew 19
Joshua 12-13;Psalm 145;Jeremiah 6;Matthew 20
Joshua 14-15;Psalm 146-147;Jeremiah 7;Matthew 21
Joshua 16-17;Psalm 148;Jeremiah 8;Matthew 22
Joshua 18-19;Psalm 149-150;Jeremiah 9;Matthew 23
Joshua 20-21;Acts 1;Jeremiah 10;Matthew 24
Joshua 22;Acts 2;Jeremiah 11;Matthew 25
Joshua 23;Acts 3;Jeremiah 12;Matthew 26
Joshua 24;Acts 4;Jeremiah 13;Matthew 27
Judges 1;Acts 5;Jeremiah 14;Matthew 28
Judges 2;Acts 6;Jeremiah 15;Mark 1
Judges 3;Acts 7;Jeremiah 16;Mark 2
Judges 4;Acts 8;Jeremiah 17;Mark 3
Judges 5;Acts 9;Jeremiah 18;Mark 4
Judges 6;Acts 10;Jeremiah 19;Mark 5
Judges 7;Acts 11;Jeremiah 20;Mark 6
Judges 8;Acts 12;Jeremiah 21;Mark 7
Judges 9;Acts 13;Jeremiah 22;Mark 8
Judges 10;Acts 14;Jeremiah 23;Mark 9
Judges 11;Acts 15;Jeremiah 24;Mark 10
Judges 12;Acts 16;Jeremiah 25;Mark 11
Judges 13;Acts 17;Jeremiah 26;Mark 12
Judges 14;Acts 18;Jeremiah 27;Mark 13
Judges 15;Acts 19;Jeremiah 28;Mark 14
Judges 16;Acts 20;Jeremiah 29;Mark 15
Judges 17;Acts 21;Jeremiah 30-31;Mark 16
Judges 18;Acts 22;Jeremiah 32;Luke 1
Judges 19;Acts 23;Jeremiah 33;Luke 2
Judges 20;Acts 24;Jeremiah 34;Luke 3
Judges 21;Acts 25;Jeremiah 35;Luke 4
Ruth 1;Acts 26;Jeremiah 36;Luke 5
Ruth 2;Acts 27;Jeremiah 37;Luke 6
Ruth 3-4;Acts 28;Jeremiah 38;Luke 7
1 Samuel 1;Romans 1;Jeremiah 39;Luke 8
1 Samuel 2;Romans 2;Jeremiah 40;Luke 9
1 Samuel 3;Romans 3;Jeremiah 41;Luke 10
1 Samuel 4;Romans 4;Jeremiah 42;Luke 11
1 Samuel 5-6;Romans 5;Jeremiah 43;Luke 12
1 Samuel 7-8;Romans 6;Jeremiah 44-45;Luke 13
1 Samuel 9;Romans 7;Jeremiah 46;Luke 14
1 Samuel 10;Romans 8;Jeremiah 47;Luke 15
1 Samuel 11;Romans 9;Jeremiah 48;Luke 16
1 Samuel 12;Romans 10;Jeremiah 49;Luke 17
1 Samuel 13;Romans 11;Jeremiah 50;Luke 18
1 Samuel 14;Romans 12;Jeremiah 51;Luke 19
1 Samuel 15;Romans 13;Jeremiah 52;Luke 20
1 Samuel 16;Romans 14;Lamentations 1;Luke 21
1 Samuel 17;Romans 15;Lamentations 2;Luke 22
1 Samuel 18;Romans 16;Lamentations 3;Luke 23
1 Samuel 19;1 Corinthians 1;Lamentations 4;Luke 24
1 Samuel 20;1 Corinthians 2;Lamentations 5;John 1
1 Samuel 21-22;1 Corinthians 3;Ezekiel 1;John 2
1 Samuel 23;1 Corinthians 4;Ezekiel 2;John 3
1 Samuel 24;1 Corinthians 5;Ezekiel 3;John 4
1 Samuel 25;1 Corinthians 6;Ezekiel 4;John 5
1 Samuel 26;1 Corinthians 7;Ezekiel 5;John 6
1 Samuel 27;1 Corinthians 8;Ezekiel 6;John 7
1 Samuel 28;1 Corinthians 9;Ezekiel 7;John 8
1 Samuel 29-30;1 Corinthians 10;Ezekiel 8;John 9
1 Samuel 31;1 Corinthians 11;Ezekiel 9;John 10
2 Samuel 1;1 Corinthians 12;Ezekiel 10;John 11
2 Samuel 2;1 Corinthians 13;Ezekiel 11;John 12
2 Samuel 3;1 Corinthians 14;Ezekiel 12;John 13
2 Samuel 4-5;1 Corinthians 15;Ezekiel 13;John 14
2 Samuel 6;1 Corinthians 16;Ezekiel 14;John 15
2 Samuel 7;2 Corinthians 1;Ezekiel 15;John 16
2 Samuel 8-9;2 Corinthians 2;Ezekiel 16;John 17
2 Samuel 10;2 Corinthians 3;Ezekiel 17;John 18
2 Samuel 11;2 Corinthians 4;Ezekiel 18;John 19
2 Samuel 12;2 Corinthians 5;Ezekiel 19;John 20
2 Samuel 13;2 Corinthians 6;Ezekiel 20;John 21
2 Samuel 14;2 Corinthians 7;Ezekiel 21;Psalm 1-2
2 Samuel 15;2 Corinthians 8;Ezekiel 22;Psalm 3-4
2 Samuel 16;2 Corinthians 9;Ezekiel 23;Psalm 5-6
2 Samuel 17;2 Corinthians 10;Ezekiel 24;Psalm 7-8
2 Samuel 18;2 Corinthians 11;Ezekiel 25;Psalm 9
2 Samuel 19;2 Corinthians 12;Ezekiel 26;Psalm 10
2 Samuel 20;2 Corinthians 13;Ezekiel 27;Psalm 11-12
2 Samuel 21;Galatians 1;Ezekiel 28;Psalm 13-14
2 Samuel 22;Galatians 2;Ezekiel 29;Psalm 15-16
2 Samuel 23;Galatians 3;Ezekiel 30;Psalm 17
2 Samuel 24;Galatians 4;Ezekiel 31;Psalm 18
1 Kings 1;Galatians 5;Ezekiel 32;Psalm 19
1 Kings 2;Galatians 6;Ezekiel 33;Psalm 20-21
1 Kings 3;Ephesians 1;Ezekiel 34;Psalm 22
1 Kings 4-5;Ephesians 2;Ezekiel 35;Psalm 23-24
1 Kings 6;Ephesians 3;Ezekiel 36;Psalm 25
1 Kings 7;Ephesians 4;Ezekiel 37;Psalm 26-27
1 Kings 8;Ephesians 5;Ezekiel 38;Psalm 28-29
1 Kings 9;Ephesians 6;Ezekiel 39;Psalm 30
1 Kings 10;Philippians 1;Ezekiel 40;Psalm 31
1 Kings 11;Philippians 2;Ezekiel 41;Psalm 32
1 Kings 12;Philippians 3;Ezekiel 42;Psalm 33
1 Kings 13;Philippians 4;Ezekiel 43;Psalm 34
1 Kings 14;Colossians 1;Ezekiel 44;Psalm 35
1 Kings 15;Colossians 2;Ezekiel 45;Psalm 36
1 Kings 16;Colossians 3;Ezekiel 46;Psalm 37
1 Kings 17;Colossians 4;Ezekiel 47;Psalm 38
1 Kings 18;1 Thessalonians 1;Ezekiel 48;Psalm 39
1 Kings 19;1 Thessalonians 2;Daniel 1;Psalm 40-41
1 Kings 20;1 Thessalonians 3;Daniel 2;Psalm 42-43
1 Kings 21;1 Thessalonians 4;Daniel 3;Psalm 44
1 Kings 22;1 Thessalonians 5;Daniel 4;Psalm 45
2 Kings 1;2 Thessalonians 1;Daniel 5;Psalm 46-47
2 Kings 2;2 Thessalonians 2;Daniel 6;Psalm 48
2 Kings 3;2 Thessalonians 3;Daniel 7;Psalm 49
2 Kings 4;1 Timothy 1;Daniel 8;Psalm 50
2 Kings 5;1 Timothy 2;Daniel 9;Psalm 51
2 Kings 6;1 Timothy 3;Daniel 10;Psalm 52-54
2 Kings 7;1 Timothy 4;Daniel 11;Psalm 55
2 Kings 8;1 Timothy 5;Daniel 12;Psalm 56-57
2 Kings 9;1 Timothy 6;Hosea 1;Psalm 58-59
2 Kings 10-11;2 Timothy 1;Hosea 2;Psalm 60-61
2 Kings 12;2 Timothy 2;Hosea 3-4;Psalm 62-63
2 Kings 13;2 Timothy 3;Hosea 5-6;Psalm 64-65
2 Kings 14;2 Timothy 4;Hosea 7;Psalm 66-67
2 Kings 15;Titus 1;Hosea 8;Psalm 68
2 Kings 16;Titus 2;Hosea 9;Psalm 69
2 Kings 17;Titus 3;Hosea 10;Psalm 70-71
2 Kings 18;Philemon 1;Hosea 11;Psalm 72
2 Kings 19;Hebrews 1;Hosea 12;Psalm 73
2 Kings 20;Hebrews 2;Hosea 13;Psalm 74
2 Kings 21;Hebrews 3;Hosea 14;Psalm 75-76
2 Kings 22;Hebrews 4;Joel 1;Psalm 77
2 Kings 23;Hebrews 5;Joel 2;Psalm 78
2 Kings 24;Hebrews 6;Joel 3;Psalm 79
2 Kings 25;Hebrews 7;Amos 1;Psalm 80
1 Chronicles 1-2;Hebrews 8;Amos 2;Psalm 81-82
1 Chronicles 3-4;Hebrews 9;Amos 3;Psalm 83-84
1 Chronicles 5-6;Hebrews 10;Amos 4;Psalm 85
1 Chronicles 7-8;Hebrews 11;Amos 5;Psalm 86
1 Chronicles 9-10;Hebrews 12;Amos 6;Psalm 87-88
1 Chronicles 11-12;Hebrews 13;Amos 7;Psalm 89
1 Chronicles 13-14;James 1;Amos 8;Psalm 90
1 Chronicles 15;James 2;Amos 9;Psalm 91
1 Chronicles 16;James 3;Obadiah 1;Psalm 92-93
1 Chronicles 17;James 4;Jonah 1;Psalm 94
1 Chronicles 18;James 5;Jonah 2;Psalm 95-96
1 Chronicles 19-20;1 Peter 1;Jonah 3;Psalm 97-98
1 Chronicles 21;1 Peter 2;Jonah 4;Psalm 99-101
1 Chronicles 22;1 Peter 3;Micah 1;Psalm 102
1 Chronicles 23;1 Peter 4;Micah 2;Psalm 103
1 Chronicles 24-25;1 Peter 5;Micah 3;Psalm 104
1 Chronicles 26-27;2 Peter 1;Micah 4;Psalm 105
1 Chronicles 28;2 Peter 2;Micah 5;Psalm 106
1 Chronicles 29;2 Peter 3;Micah 6;Psalm 107
2 Chronicles 1;1 John 1;Micah 7;Psalm 108-109
2 Chronicles 2;1 John 2;Nahum 1;Psalm 110-111
2 Chronicles 3-4;1 John 3;Nahum 2;Psalm 112-113
2 Chronicles 5;1 John 4;Nahum 3;Psalm 114-115
2 Chronicles 6;1 John 5;Habakkuk 1;Psalm 116
2 Chronicles 7;2 John 1;Habakkuk 2;Psalm 117-118
2 Chronicles 8;3 John 1;Habakkuk 3;Psalm 119:1-24
2 Chronicles 9;Jude 1;Zephaniah 1;Psalm 119:25-48
2 Chronicles 10;Revelation 1;Zephaniah 2;Psalm 119:49-72
2 Chronicles 11-12;Revelation 2;Zephaniah 3;Psalm 119:73-96
2 Chronicles 13;Revelation 3;Haggai 1;Psalm 119:97-120
2 Chronicles 14-15;Revelation 4;Haggai 2;Psalm 119:121-144
2 Chronicles 16;Revelation 5;Zechariah 1;Psalm 119:145-176
2 Chronicles 17;Revelation 6;Zechariah 2;Psalm 120-122
2 Chronicles 18;Revelation 7;Zechariah 3;Psalm 123-125
2 Chronicles 19-20;Revelation 8;Zechariah 4;Psalm 126-128
2 Chronicles 21;Revelation 9;Zechariah 5;Psalm 129-131
2 Chronicles 22-23;Revelation 10;Zechariah 6;Psalm 132-134
2 Chronicles 24;Revelation 11;Zechariah 7;Psalm 135-136
2 Chronicles 25;Revelation 12;Zechariah 8;Psalm 137-138
2 Chronicles 26;Revelation 13;Zechariah 9;Psalm 139
2 Chronicles 27-28;Revelation 14;Zechariah 10;Psalm 140-141
2 Chronicles 29;Revelation 15;Zechariah 11;Psalm 142
2 Chronicles 30;Revelation 16;Zechariah 12;Psalm 143
2 Chronicles 31;Revelation 17;Zechariah 13;Psalm 144
2 Chronicles 32;Revelation 18;Zechariah 14;Psalm 145
2 Chronicles 33;Revelation 19;Malachi 1;Psalm 146-147
2 Chronicles 34;Revelation 20;Malachi 2;Psalm 148
2 Chronicles 35;Revelation 21;Malachi 3;Psalm 149
2 Chronicles 36;Revelation 22;Malachi 4;Psalm 150
`;
export const MCHEYNE = TABLE.trim().split(/\n/).map((line) => line.split(';'));
