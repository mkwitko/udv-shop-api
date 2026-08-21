import { db } from "../../../infra/db/client.js";
import { ValidationError } from "../../../shared/errors.js";
import { createProductCategoriesRepository } from "../product-categories/product-categories.repository.js";

/**
 * Categoria só vale se for da MESMA loja da rota. O id chega do cliente, então ele é
 * pergunta, não prova: sem esta checagem um produto do núcleo A podia apontar para uma
 * gaveta do núcleo B e vazar o nome dela na vitrine.
 *
 * A mensagem é genérica de propósito — "existe mas é de outra loja" já seria informação
 * sobre a loja alheia.
 */
export async function assertCategoryForStore(
  storeId: string,
  categoryId: string | null | undefined,
): Promise<void> {
  if (!categoryId) return;
  const found = await createProductCategoriesRepository(db).findInStore(storeId, categoryId);
  if (!found) throw new ValidationError("category_not_found");
}
