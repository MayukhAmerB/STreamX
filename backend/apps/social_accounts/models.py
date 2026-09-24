from config.model_validators import validate_no_active_content, validate_safe_public_url
from django.db import models
from django.utils.text import slugify


class SocialAccountCategory(models.Model):
    ICON_YOUTUBE = "youtube"
    ICON_INSTAGRAM = "instagram"
    ICON_X = "x"
    ICON_FACEBOOK = "facebook"
    ICON_LINK = "link"
    ICON_CHOICES = [
        (ICON_YOUTUBE, "YouTube"),
        (ICON_INSTAGRAM, "Instagram"),
        (ICON_X, "X"),
        (ICON_FACEBOOK, "Facebook"),
        (ICON_LINK, "Generic link"),
    ]

    name = models.CharField(max_length=80, unique=True)
    slug = models.SlugField(max_length=90, unique=True, blank=True)
    description = models.TextField(max_length=600, blank=True, default="")
    icon_key = models.CharField(max_length=20, choices=ICON_CHOICES, default=ICON_LINK)
    sort_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("sort_order", "name", "pk")
        verbose_name = "AS account category"
        verbose_name_plural = "AS account categories"
        indexes = [models.Index(fields=("is_active", "sort_order"), name="as_cat_active_sort_idx")]

    def clean(self):
        super().clean()
        validate_no_active_content(self.name, "name")
        validate_no_active_content(self.description, "description")

    def save(self, *args, **kwargs):
        if not self.slug:
            self.slug = slugify(self.name)
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return self.name


class SocialAccount(models.Model):
    category = models.ForeignKey(
        SocialAccountCategory,
        on_delete=models.PROTECT,
        related_name="accounts",
    )
    account_name = models.CharField(max_length=120)
    handle = models.CharField(max_length=120, blank=True, default="")
    url = models.URLField(max_length=500)
    managed_by = models.CharField(max_length=160, blank=True, default="")
    description = models.TextField(max_length=500, blank=True, default="")
    status_label = models.CharField(max_length=40, default="Active")
    sort_order = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("sort_order", "account_name", "pk")
        verbose_name = "AS account"
        verbose_name_plural = "AS accounts"
        constraints = [
            models.UniqueConstraint(fields=("category", "url"), name="as_acc_url_cat_uniq")
        ]
        indexes = [
            models.Index(fields=("category", "is_active", "sort_order"), name="as_acc_cat_active_sort_idx")
        ]

    def clean(self):
        super().clean()
        for field_name in ("account_name", "handle", "managed_by", "description", "status_label"):
            validate_no_active_content(getattr(self, field_name), field_name)
        validate_safe_public_url(self.url, "url")

    def save(self, *args, **kwargs):
        self.url = str(self.url or "").strip()
        self.full_clean()
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.account_name} ({self.category.name})"
