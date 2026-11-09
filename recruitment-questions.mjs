const q=(id,ru,uz,kind='text',required=false,max=500)=>({id,ru,uz,kind,required,max});
export const recruitmentQuestions=[
 q('role','На какую должность вы подаёте заявку?','Qaysi lavozimga ariza topshirmoqchisiz?','text',true,80),
 q('salary','Какую зарплату ожидаете, в сумах за месяц?','Oyiga qancha ish haqi kutmoqdasiz, so‘mda?','money',true,30),
 q('name','Укажите фамилию, имя и отчество.','Familiyangiz, ismingiz va otangizning ismini yozing.','text',true,80),
 q('birth','Дата рождения в формате ДД.ММ.ГГГГ.','Tug‘ilgan sanangizni KK.OO.YYYY shaklida yozing.','date'),
 q('address','Ваш адрес проживания.','Yashash manzilingiz.'),
 q('phone','Ваш номер телефона. Можно нажать «Поделиться телефоном».','Telefon raqamingiz. «Telefonni yuborish» tugmasidan foydalanishingiz mumkin.','phone',true,30),
 q('family','Ваше семейное положение.','Oilaviy holatingiz.'),
 q('children','Есть ли дети? Если хотите, укажите количество.','Farzandlaringiz bormi? Xohlasangiz, sonini ko‘rsating.'),
 q('health','Есть ли хронические заболевания? Ответ можно пропустить.','Surunkali kasalliklaringiz bormi? Javobni o‘tkazib yuborishingiz mumkin.'),
 q('disability','Есть ли инвалидность? Если хотите, укажите группу. Ответ можно пропустить.','Nogironlik bormi? Xohlasangiz, guruhini ko‘rsating. Javobni o‘tkazib yuborishingiz mumkin.'),
 q('alcohol','Употребляете ли алкоголь? Ответ можно пропустить.','Spirtli ichimlik ichasizmi? Javobni o‘tkazib yuborishingiz mumkin.','yesno'),
 q('smoking','Курите ли вы? Ответ можно пропустить.','Chekasizmi? Javobni o‘tkazib yuborishingiz mumkin.','yesno'),
 q('driver','Есть ли водительское удостоверение?','Haydovchilik guvohnomangiz bormi?','yesno'),
 q('categories','Категории удостоверения: A, B, C, D, BE, CE, DE.','Guvohnoma toifalari: A, B, C, D, BE, CE, DE.'),
 q('car','Есть ли личный автомобиль?','Shaxsiy avtomobilingiz bormi?','yesno'),
 q('carModel','Марка личного автомобиля.','Shaxsiy avtomobilingiz rusumi.'),
 q('criminal','Есть ли судимость? Ответ можно пропустить.','Sudlanganlik bormi? Javobni o‘tkazib yuborishingiz mumkin.','yesno'),
 q('criminalDetails','Если хотите, укажите год, срок и причину судимости.','Xohlasangiz, sudlanganlik yili, muddati va sababini ko‘rsating.'),
 q('education','Уровень образования: школа, среднее специальное, бакалавр, магистр, PhD.','Ta’lim turi: maktab, o‘rta maxsus, bakalavr, magistr, PhD.'),
 q('school','Название учебного заведения.','Ta’lim muassasasining nomi.'),
 q('specialty','Специальность.','Mutaxassisligingiz.'),
 q('studyYears','Годы обучения.','O‘qigan yillaringiz.'),
 q('computer','Общий уровень компьютерной грамотности.','Umumiy kompyuter savodxonligi darajangiz.'),
 q('excel','Ваш уровень владения Microsoft Excel.','Microsoft Excel dasturidan foydalanish darajangiz.'),
 q('word','Ваш уровень владения Microsoft Word.','Microsoft Word dasturidan foydalanish darajangiz.'),
 q('programs','Другие программы и уровень владения.','Boshqa dasturlar va ulardan foydalanish darajangiz.'),
 ...[1,2].flatMap(n=>[
  q('company'+n,`Место работы ${n}: название организации. Можно указать неофициальную работу.`,`${n}-ish joyi: tashkilot nomi. Norasmiy ishni ham ko‘rsatishingiz mumkin.`),
  q('jobRole'+n,`Место работы ${n}: должность.`,`${n}-ish joyi: lavozimingiz.`),
  q('experience'+n,`Место работы ${n}: полученный опыт, задачи и трудности.`,`${n}-ish joyi: olgan tajribangiz, vazifalar va qiyinchiliklar.`, 'text',false,1000),
  q('leave'+n,`Место работы ${n}: причина увольнения.`,`${n}-ish joyi: ishdan bo‘shash sababi.`),
  q('jobSalary'+n,`Место работы ${n}: зарплата в сумах.`,`${n}-ish joyi: oylik ish haqi so‘mda.`, 'money'),
  q('reference'+n,`Место работы ${n}: телефон руководителя для рекомендации. Укажите с его согласия.`,`${n}-ish joyi: tavsiyanoma beruvchi rahbarning telefoni. Uning roziligi bilan ko‘rsating.`),
 ]),
 q('portrait','Пришлите своё фото как изображение JPEG или PNG, до 3 МБ. Можно пропустить.','O‘z fotosuratingizni JPEG yoki PNG shaklida yuboring, 3 MB gacha. O‘tkazib yuborish mumkin.','photo'),
 q('paper','Если у вас есть заполненная бумажная анкета, пришлите её фото JPEG или PNG, до 3 МБ. Иначе нажмите «Пропустить».','To‘ldirilgan qog‘oz savolnomangiz bo‘lsa, uning fotosini JPEG yoki PNG shaklida yuboring, 3 MB gacha. Bo‘lmasa, «O‘tkazish» tugmasini bosing.','photo'),
];
export const recruitmentWords={
 ru:{yes:'Да',no:'Нет',skip:'Пропустить',back:'Назад',cancel:'Отменить',agree:'Согласен',decline:'Не согласен',submit:'Отправить заявку',edit:'Изменить ответы',share:'Поделиться телефоном',new:'Новая анкета',resume:'Продолжить',status:'Моя заявка',consent:'TAMEER HR\nАнкета для рассмотрения вашей кандидатуры на работу. Ответы, контакты и фотографии будут переданы в базу TAMEER и доступны уполномоченным сотрудникам TAMEER. Анкета включает добровольные вопросы о здоровье, инвалидности и судимости: их можно пропустить.\nНажимая «Согласен», вы добровольно соглашаетесь на сбор, хранение и обработку предоставленных вами данных и фото для подбора персонала. Не отправляйте паспорт и другие документы.\nВы согласны?',required:'Этот ответ обязателен.',invalid:'Проверьте ответ. ',photoError:'Не удалось сохранить фото. Пришлите JPEG или PNG до 3 МБ либо пропустите вопрос.',review:'Проверьте ответы перед отправкой. Загруженные фото хранятся в закрытой базе. Для исправления выберите «Изменить ответы» или «Назад».',done:'Заявка сохранена. Администратор рассмотрит её. Это не означает приём на работу.',cancelled:'Заполнение отменено. Заявка не отправлена.',none:'Вы ещё не отправляли заявку.',choose:'TAMEER HR\nВыберите язык / Tilni tanlang',help:'/start — начать или продолжить\n/back — предыдущий вопрос\n/skip — пропустить необязательный ответ\n/status — ваша последняя заявка\n/cancel — отменить заполнение',stages:{new:'Получена',screening:'На рассмотрении',interview:'Собеседование',offer:'Предложение',hired:'Принят',rejected:'Рассмотрение завершено',withdrawn:'Снята'},empty:'Не указано',file:'Фото приложено'},
 uz:{yes:'Ha',no:'Yo‘q',skip:'O‘tkazish',back:'Orqaga',cancel:'Bekor qilish',agree:'Roziman',decline:'Rozi emasman',submit:'Arizani yuborish',edit:'Javoblarni o‘zgartirish',share:'Telefonni yuborish',new:'Yangi savolnoma',resume:'Davom etish',status:'Mening arizam',consent:'TAMEER HR\nIshga qabul qilish uchun nomzodingizni ko‘rib chiqish savolnomasi. Javoblar, kontaktlar va fotosuratlar TAMEER bazasiga yuboriladi va TAMEER vakolatli xodimlariga ko‘rinadi. Sog‘liq, nogironlik va sudlanganlik haqidagi savollar ixtiyoriy: ularni o‘tkazib yuborishingiz mumkin.\n«Roziman» tugmasini bosib, xodimlarni tanlash maqsadida taqdim etgan ma’lumotlaringiz va fotosuratlaringizni yig‘ish, saqlash va ularga ishlov berishga ixtiyoriy rozilik bildirasiz. Pasport va boshqa hujjatlarni yubormang.\nRozimisiz?',required:'Bu savolga javob berish shart.',invalid:'Javobni tekshiring. ',photoError:'Foto saqlanmadi. 3 MB gacha JPEG yoki PNG yuboring yoki savolni o‘tkazib yuboring.',review:'Yuborishdan oldin javoblarni tekshiring. Yuklangan fotolar yopiq bazada saqlanadi. Tuzatish uchun «Javoblarni o‘zgartirish» yoki «Orqaga»ni tanlang.',done:'Ariza saqlandi. Administrator uni ko‘rib chiqadi. Bu ishga qabul qilinganlikni anglatmaydi.',cancelled:'To‘ldirish bekor qilindi. Ariza yuborilmadi.',none:'Siz hali ariza yubormagansiz.',choose:'TAMEER HR\nВыберите язык / Tilni tanlang',help:'/start — boshlash yoki davom etish\n/back — oldingi savol\n/skip — ixtiyoriy javobni o‘tkazish\n/status — oxirgi arizangiz\n/cancel — to‘ldirishni bekor qilish',stages:{new:'Qabul qilindi',screening:'Ko‘rib chiqilmoqda',interview:'Suhbat',offer:'Taklif',hired:'Ishga qabul qilindi',rejected:'Ko‘rib chiqish yakunlandi',withdrawn:'Bekor qilindi'},empty:'Ko‘rsatilmagan',file:'Foto ilova qilingan'}
};
Object.assign(recruitmentWords.ru,{chooseDirection:'Выберите направление работы',chooseVacancy:'Выберите вакансию',store:'Магазин',available:'Свободных мест',noVacancies:'Сейчас открытых вакансий со свободными местами нет. Нажмите «Обновить вакансии» позже.',refreshVacancies:'Обновить вакансии',prevPage:'← Предыдущие',nextPage:'Следующие →',vacancyChanged:'Вакансия закрыта или изменена. Выберите актуальную вакансию. Ответы анкеты сохранены.',chosenVacancy:'Выбрана вакансия'});
Object.assign(recruitmentWords.uz,{chooseDirection:'Ish yo‘nalishini tanlang',chooseVacancy:'Vakansiyani tanlang',store:'Do‘kon',available:'Bo‘sh o‘rinlar',noVacancies:'Hozir bo‘sh o‘rinli ochiq vakansiyalar yo‘q. Keyinroq «Vakansiyalarni yangilash» tugmasini bosing.',refreshVacancies:'Vakansiyalarni yangilash',prevPage:'← Oldingi',nextPage:'Keyingi →',vacancyChanged:'Vakansiya yopilgan yoki o‘zgargan. Amaldagi vakansiyani tanlang. Savolnoma javoblari saqlangan.',chosenVacancy:'Tanlangan vakansiya'});
