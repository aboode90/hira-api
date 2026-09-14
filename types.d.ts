interface AdminReports {
  totalOrders: number;
  completedOrders: number;
  pendingOrders: number;
  deliveringOrders: number;
  cancelledOrders: number;
  ordersByStatus: Record<string, number>;
  totalSales: number;
  codCollected: number;
  avgOrderValue: number;
  recentRevenue: number;
  revenueGrowth: number;
  totalMerchants: number;
  openMerchants: number;
  frozenMerchants: number;
  pendingMerchantsCount: number;
  rejectedMerchantsCount: number;
  bazaarMerchants: number;
  topMerchants: Array<{
    phone: string;
    storeName: string;
    revenue: number;
    orderCount: number;
  }>;
  totalProducts: number;
  totalUsers: number;
  activeUsersCount: number;
  totalCouriers: number;
  totalDrivers: number;
  totalAdminAccounts: number;
  recentOrders: Array<RecentOrderSummary>;
}

interface RecentOrderSummary {
  id: string;
  orderNumber: string;
  statusKey: string;
  statusAr: string;
  price: number;
  merchantStoreName: string;
  customerNameAr: string;
  deliveryStatusKey: string;
  updatedAt: string | null;
}
